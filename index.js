const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const sequelize = require('./sequelize');
const he = require('he');
const TurndownService = require('turndown');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

let dataLock = false;

async function assertDatabaseConnectionOk() {
	console.log(`Checking database connection...`);
	try {
		await sequelize.authenticate();
	} catch (error) {
		console.log('Unable to connect to the database:', error.message);
		process.exit(1);
	}
}

// The baseUrl for fetching forum threads
const baseUrl = process.env.BASE_URL;

const client = new Client({
     intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,  
    ],
 });

console.log("Booting...");

client.once('ready', async () => {
    await assertDatabaseConnectionOk();
    setInterval(async () => {
        await listenForNewPosts();
    }, 2 * 60 * 1000);
    console.log("Ready!");    
});

client.on("messageCreate", async (message) => {
    if(message.author.bot) return;

    if(message.content.startsWith("^forum_sync")) {
        const threadId = message.content.split(" ")[1];
        const allPosts = await fetchAllPosts(threadId);
        
        if(allPosts.length == 0) { 
            await message.reply("Error trying to get forum thread. Did you provided a valid thread id?");
            return;
        }

        const threadModel = sequelize.models.thread;
        const [thread, created] = await threadModel.findOrCreate(
            {where: 
                {id: threadId}, 
            defaults: 
                { discord_channel: message.channel.id.replace(/<#(\d+)>/, '$1') }
            });
        
        if(created) {
            dataLock = true;
            await message.channel.send(`# [${allPosts[0].title}](${baseUrl}/t/${allPosts[0].topic_slug})`);
            for(post of allPosts) {                    
                const msg = await sendDiscordMessage(message.channel, post, thread);
                if(msg) {
                    try {
                        await thread.createPost({
                            id: post.id,
                            post_number: post.post_number,
                            reply_to: post.reply_to,
                            discord_id: `${msg.id}`,
                            createdAt: new Date(post.created_at),
                            editedAt: new Date(post.updated_at)
                        });
                    }
                    catch(e) {
                        console.log(e);
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            dataLock = false;
        }
        else {
            await message.reply(`This forum thread is already connected with the channel ${thread.discord_channel}.`);
        }
    }
});

function convertHtmlToMarkdown(htmlContent) {
    const turndownService = new TurndownService();
    
    // Customize rules to fit Discord's Markdown requirements
    turndownService.addRule('heading', {
        filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        replacement: function(content, node, options) {
            const hLevel = Number(node.nodeName.charAt(1));
            const hash = '#'.repeat(hLevel);
            return `${hash} ${content}\n`;
        }
    });
  
    turndownService.addRule('bold', {
        filter: ['strong', 'b'],
        replacement: function(content) {
            return `**${content}**`;
        }
    });
    
    turndownService.addRule('italic', {
        filter: ['em', 'i'],
        replacement: function(content) {
            return `*${content}*`;
        }
    });
    
    turndownService.addRule('inlineCode', {
        filter: function(node) {
        return (
            node.nodeName === 'CODE' &&
            node.parentNode.nodeName !== 'PRE'
        );
        },
        replacement: function(content) {
            return `\`${content}\``;
        }
    });
    
    turndownService.addRule('codeBlock', {
        filter: 'pre',
        replacement: function(content) {
            return `\`\`\`\n${content}\n\`\`\`\n`;
        }
    });
    
    turndownService.addRule('listItem', {
        filter: 'li',
        replacement: function(content, node, options) {
            content = content.replace(/^\s+/, '').replace(/\n/gm, '\n    ');
            let prefix = '* ';
            const parent = node.parentNode;
            if (parent.nodeName === 'OL') {
                const start = parent.getAttribute('start');
                const index = Array.prototype.indexOf.call(parent.children, node);
                prefix = (start ? Number(start) + index : index + 1) + '. ';
            }
            return prefix + content;
        }
    });

    turndownService.addRule('usernameLink', {
        filter: node => {
          return node.nodeName === 'A' && node.getAttribute('href') && node.getAttribute('href').startsWith('/u/');
        },
        replacement: (content, node) => {
          const username = node.textContent.trim();
          return `${username}`;
        }
    });

    // turndownService.addRule('replaceImages', {
    //     filter: 'img',
    //     replacement: (content, node) => {
    //       const imageUrl = node.getAttribute('src');
    //       return imageUrl ? `[Image link](${imageUrl})` : '';
    //     }
    // });
    
    turndownService.addRule('removeImages', {
        filter: 'img',
        replacement: () => ''
    });

    return turndownService.turndown(htmlContent);
}

async function sendDiscordMessage(channel, post, thread) {
    const username = post.username;
    let content = convertHtmlToMarkdown(post.content);
    if(!content || content == '') content = "(error fetching message)";

    const messageEmbed = new EmbedBuilder()
        .setColor(0x5dbadd)
        .setAuthor({ name: `${username}`, iconURL: post.avatar_url, url: `${baseUrl}/t/${thread.id}/${post.post_number}` })
        .setDescription(content.length > 4000 ? `${content.substring(0, 3800)}[...] [read more](${baseUrl}/t/${thread.id}/${post.post_number})` : `${content}`)
        .setTimestamp(new Date(post.created_at));

        if(post.reply_to) {
            const threadPosts = await thread.getPosts({where: {post_number: post.reply_to}});            
            try {
                const msg_id = `${threadPosts[0].discord_id}`;
                const msg_ref = await channel.messages.fetch(`${msg_id}`);            
                return await msg_ref.reply( { embeds: [messageEmbed] } );
            }
            catch(e) {
                console.log("Message doesn't exist.");
            }
        }
        return await channel.send({ embeds: [messageEmbed] });
}

async function listenForNewPosts() {
    if(dataLock) {
        console.log("Waiting for posts to sync ...");
        return;
    }

    const threadModel = sequelize.models.thread;
    const allThreads = await threadModel.findAll();
    if(allThreads.length == 0) {
        console.log("No threads found in database.");
        return;
    }

    dataLock = true;
    for(thread of allThreads) {
        const allPosts = await fetchAllPosts(thread.id);        
        const latestPost = await thread.getPosts({
            order: [['post_number', 'DESC']],
            limit: 1
        });

        console.log(`Checking new posts for thread ${thread.id}`);
        const channel_id = thread.discord_channel;
        const channel = await client.channels.fetch(`${channel_id}`);
        const newPosts = allPosts.filter((post) => post.post_number > latestPost[0].post_number);

        if (newPosts.length > 0) {
            for(post of newPosts) {                    
                const msg = await sendDiscordMessage(channel, post, thread);
                if(msg) {
                    try {
                        await thread.createPost({
                            id: post.id,
                            post_number: post.post_number,
                            reply_to: post.reply_to,
                            discord_id: `${msg.id}`,
                            createdAt: new Date(post.created_at),
                            editedAt: new Date(post.updated_at)
                        });
                    }
                    catch(e) {
                        console.log(e);
                    }
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }        
        else {
            console.log(`No new posts on thread ${thread.id}`);
        }
        // check for edited posts
        console.log(`Checking for edited messages on thread ${thread.id}`);
        for (post of allPosts) {
            const db_post = await thread.getPosts({
                where: {
                    post_number: post.post_number
                }
            });
            if(db_post) {
                const db_edited = new Date(db_post[0].editedAt);
                const post_updated = new Date(post.updated_at);   
                
                if(post_updated > db_edited) {
                    console.log(`post number ${post.post_number} of thread ${thread.id} was edited.`);

                    let new_content = convertHtmlToMarkdown(post.content);
                    if (!new_content || new_content == '') new_content = "(error fetching message)";
                    const msg_id = `${db_post[0].discord_id}`;

                    try {
                        const messageEmbed = new EmbedBuilder()
                            .setColor(0x5dbadd)
                            .setAuthor({ name: `${post.username}`, iconURL: post.avatar_url, url: `${baseUrl}/t/${thread.id}/${post.post_number}` })
                            .setDescription(new_content.length > 4000 ? `${new_content.substring(0, 3800)}[...] [read more](${baseUrl}/t/${thread.id}/${post.post_number})` : `${new_content}`)
                            .setTimestamp(new Date(post.created_at));

                        const msg_ref = await channel.messages.fetch(`${msg_id}`);            
                        await msg_ref.edit( { embeds: [messageEmbed] } );
                        
                        // db_post[0].updatedAt = post_updated;
                        // await db_post[0].save();
                        await db_post[0].update({ editedAt: post_updated });
                    }
                    catch(e) {
                        console.log("Error editing message.", e);
                    }
                }
                else {
                    console.log(`No edits on thread ${thread.id}`);
                }
            }
        }
    }
    dataLock = false;
}

async function fetchThreadPage(topicId, page) {
    try {
      const response = await axios.get(`${baseUrl}/t/${topicId}.json?page=${page}`, {timeout: 10 * 1000});
      return response.data;
    } catch (error) {
      console.error(`Error fetching the thread page ${page}`);
    //   throw error;
      return null;
    }
}

async function fetchAllPosts(threadId) {
    let page = 1;
    let allPosts = [];
    let threadData;
    let retryCount = 0;
    do {
        threadData = await fetchThreadPage(threadId, page);
        if(threadData && !threadData.error) {            
            const posts = threadData.post_stream.posts.map((post) => ({
                id: post.id,
                topic_slug: post.topic_slug,
                post_number: post.post_number,
                reply_to: post.reply_to_post_number,
                title: threadData.title,
                content: he.decode(post.cooked),
                username: post.username,
                created_at: post.created_at,
                updated_at: post.updated_at,
                // avatar_url: `${baseUrl}${post.avatar_template.replace('{size}', '45')}`
                avatar_url: post.avatar_template.includes('v4') ? `${post.avatar_template.replace('{size}', '45')}`: `${baseUrl}${post.avatar_template.replace('{size}', '45')}`
            }));
            allPosts = allPosts.concat(posts);
            page ++;
        }
        else {
            console.log("Error trying to fetchs posts, breaking loop");
            break;
        }
        retryCount ++;
    } while((threadData && threadData.post_stream.posts.length > 0) || retryCount > 30);
    return allPosts;
}

client.login(process.env.DISCORD_TOKEN);
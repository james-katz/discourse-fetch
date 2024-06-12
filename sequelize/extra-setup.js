function applyExtraSetup(sequelize) {
	const { thread, post } = sequelize.models;
	
	// Create threads/posts association
	thread.hasMany(post);
	post.belongsTo(thread);
}

module.exports = { applyExtraSetup };
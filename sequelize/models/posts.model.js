const { DataTypes } = require('sequelize');

// We export a function that defines the model.
// This function will automatically receive as parameter the Sequelize connection object.
module.exports = (sequelize) => {
	sequelize.define('post', {
		// The following specification of the 'id' attribute could be omitted
		// since it is the default.
		id: {
			allowNull: false,			
			primaryKey: true,
			type: DataTypes.INTEGER
		},
		post_number: {
			type: DataTypes.INTEGER,
			allowNull: false
		},
		reply_to: {
			type: DataTypes.INTEGER,
			allowNull: true
		},		
        discord_id: {
			allowNull: false,						
			type: DataTypes.STRING
		},
		editedAt: {
			allowNull: false,
			type: DataTypes.DATE
		},		
	});
};
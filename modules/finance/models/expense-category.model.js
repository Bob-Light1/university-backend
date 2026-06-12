const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
  name: {
    type: String,
  },

  createdAt: {type:Date, default: new Date()}
});

module.exports = mongoose.model('ExpenseCategory', classSchema)
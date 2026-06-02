const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  schoolCampus: {type: mongoose.Schema.ObjectId, ref: 'Campus'},
  title: {type: String, required: true},
  message: {type: String, required:true},
  audience: {type:String, enum:['student', 'teacher', 'parent', 'partner']},

  createdAt: {type:Date, default: new Date()}
});

module.exports = mongoose.model("Notification", notificationSchema)
// models/task.js
const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Task name is required'],
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    deadline: {
      type: Date,
      required: [true, 'Task deadline is required'],
    },
    completed: {
      type: Boolean,
      default: false,
    },
    assignedUser: {
      type: String, // store User _id as string
      default: '',
      trim: true,
    },
    assignedUserName: {
      type: String,
      default: 'unassigned',
      trim: true,
    },
    dateCreated: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Task', TaskSchema);

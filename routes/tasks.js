// routes/tasks.js
const express = require('express');
const mongoose = require('mongoose');
const Task = require('../models/task'); // or '../models/tak' if named that
const User = require('../models/user');

module.exports = function (router) {
  const r = express.Router();

  const parseJSON = (s) => (s ? JSON.parse(s) : undefined);
  const asBool = (v) => String(v).toLowerCase() === 'true';
  const toInt = (v, dflt = 0) => (v !== undefined ? parseInt(v, 10) : dflt);
  const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

  const ok = (res, data, message = 'OK') =>
    res.status(200).json({ message, data });
  const created = (res, data, message = 'Created') =>
    res.status(201).json({ message, data });
  const bad = (res, message = 'Bad Request', data = null) =>
    res.status(400).json({ message, data });
  const notFound = (res, message = 'Not Found', data = null) =>
    res.status(404).json({ message, data });
  const fail = (res, err) =>
    res.status(500).json({ message: 'Server Error', data: null });

  async function syncUserPendingForTask(task, prevAssignedUserId) {
    if (!task.completed && task.assignedUser) {
      await User.updateOne(
        { _id: task.assignedUser },
        { $addToSet: { pendingTasks: String(task._id) } }
      );
    }
    if (prevAssignedUserId && String(prevAssignedUserId) !== String(task.assignedUser)) {
      await User.updateOne(
        { _id: String(prevAssignedUserId) },
        { $pull: { pendingTasks: String(task._id) } }
      );
    }
    if (task.completed || !task.assignedUser) {
      if (task.assignedUser) {
        await User.updateOne(
          { _id: String(task.assignedUser) },
          { $pull: { pendingTasks: String(task._id) } }
        );
      }
    }
  }

  // GET /api/tasks
  r.get('/', async (req, res) => {
    try {
      const where = req.query.where ? parseJSON(req.query.where) : {};
      const sort = req.query.sort ? parseJSON(req.query.sort) : undefined;
      const select = req.query.select ? parseJSON(req.query.select) : undefined;
      const skip = toInt(req.query.skip, 0);
      const limit =
        req.query.limit !== undefined ? toInt(req.query.limit) : 100; // default 100 for tasks
      const count = asBool(req.query.count);

      if (count) {
        const c = await Task.countDocuments(where || {});
        return ok(res, c, 'OK');
      }

      let q = Task.find(where || {});
      if (sort) q = q.sort(sort);
      else q = q.sort({ dateCreated: -1 }); // surface newest on first page
      if (select) q = q.select(select);
      if (skip) q = q.skip(skip);
      if (limit !== undefined) q = q.limit(limit);

      const docs = await q.exec();
      return ok(res, docs);
    } catch (e) {
      if (e instanceof SyntaxError) return bad(res, 'Invalid JSON in query');
      return fail(res, e);
    }
  });

  // POST /api/tasks
  r.post('/', async (req, res) => {
    try {
      const {
        name,
        description,
        deadline,
        completed,
        assignedUser,
        assignedUserName,
      } = req.body || {};

      if (!name || !deadline) return bad(res, 'Task name and deadline are required');

      const t = await Task.create({
        name,
        description: description ?? '',
        deadline,
        completed: completed ?? false,
        assignedUser: assignedUser ?? '',
        assignedUserName: assignedUserName ?? (assignedUser ? '' : 'unassigned'),
      });

      if (t.assignedUser) {
        const u = await User.findById(t.assignedUser);
        const userName = u ? u.name : (t.assignedUserName || 'unassigned');
        if (t.assignedUserName !== userName) {
          t.assignedUserName = userName;
          await t.save();
        }
      }

      await syncUserPendingForTask(t, null);

      return created(res, t);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      return fail(res, e);
    }
  });

  // GET /api/tasks/:id (supports ?select=)
  r.get('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'Task not found');

      const select = req.query.select ? parseJSON(req.query.select) : undefined;
      let q = Task.findById(id);
      if (select) q = q.select(select);
      const doc = await q.exec();
      if (!doc) return notFound(res, 'Task not found');
      return ok(res, doc);
    } catch (e) {
      if (e instanceof SyntaxError) return bad(res, 'Invalid JSON in select');
      return fail(res, e);
    }
  });

  // PUT /api/tasks/:id
  r.put('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'Task not found');

      const {
        name,
        description,
        deadline,
        completed,
        assignedUser,
        assignedUserName,
      } = req.body || {};

      if (!name || !deadline) return bad(res, 'Task name and deadline are required');

      const before = await Task.findById(id);
      if (!before) return notFound(res, 'Task not found');

      const prevAssignedUser = before.assignedUser;

      before.name = name;
      before.description = description ?? '';
      before.deadline = deadline;
      before.completed = completed ?? false;
      before.assignedUser = assignedUser ?? '';

      if (before.assignedUser) {
        const u = await User.findById(before.assignedUser);
        before.assignedUserName = assignedUserName ?? (u ? u.name : 'unassigned');
      } else {
        before.assignedUserName = 'unassigned';
      }

      const task = await before.save();
      await syncUserPendingForTask(task, prevAssignedUser);

      return ok(res, task);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      return fail(res, e);
    }
  });

  // DELETE /api/tasks/:id
  r.delete('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'Task not found');

      const task = await Task.findById(id);
      if (!task) return notFound(res, 'Task not found');

      if (task.assignedUser) {
        await User.updateOne(
          { _id: String(task.assignedUser) },
          { $pull: { pendingTasks: String(task._id) } }
        );
      }

      await task.deleteOne();
      return res.status(204).send();
    } catch (e) {
      return fail(res, e);
    }
  });

  router.use('/tasks', r);
  return router;
};

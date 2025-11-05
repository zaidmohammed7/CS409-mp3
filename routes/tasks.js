// routes/tasks.js
const express = require('express');
const Task = require('../models/task');
const User = require('../models/user');

module.exports = function (router) {
  const r = express.Router();

  const parseJSON = (s) => (s ? JSON.parse(s) : undefined);
  const asBool = (v) => String(v).toLowerCase() === 'true';
  const toInt = (v, dflt = 0) => (v !== undefined ? parseInt(v, 10) : dflt);

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

  // helper to sync pendingTasks on a user when a task changes
  async function syncUserPendingForTask(task, prevAssignedUserId) {
    // If task is pending (completed === false) and has assignedUser -> ensure it's in that user's pendingTasks
    if (!task.completed && task.assignedUser) {
      await User.updateOne(
        { _id: task.assignedUser },
        { $addToSet: { pendingTasks: String(task._id) } }
      );
    }
    // If task was previously assigned to someone else (or now completed/unassigned), ensure removal from that user's pendingTasks
    if (prevAssignedUserId && String(prevAssignedUserId) !== String(task.assignedUser)) {
      await User.updateOne(
        { _id: String(prevAssignedUserId) },
        { $pull: { pendingTasks: String(task._id) } }
      );
    }
    // If task is completed or unassigned, ensure it is removed from its current user's pendingTasks
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
        req.query.limit !== undefined ? toInt(req.query.limit) : 100; // README: default 100 for tasks
      const count = asBool(req.query.count);

      if (count) {
        const c = await Task.countDocuments(where || {});
        return ok(res, c, 'OK');
      }

      let q = Task.find(where || {});
      if (sort) q = q.sort(sort);
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

      // Build task with defaults per README
      const t = await Task.create({
        name,
        description: description ?? '',
        deadline,
        completed: completed ?? false,
        assignedUser: assignedUser ?? '',
        assignedUserName: assignedUserName ?? (assignedUser ? '' : 'unassigned'),
      });

      // If assignedUser provided, also ensure assignedUserName is set (fallback to user name)
      if (t.assignedUser) {
        const u = await User.findById(t.assignedUser);
        const userName = u ? u.name : (t.assignedUserName || 'unassigned');
        if (t.assignedUserName !== userName) {
          t.assignedUserName = userName;
          await t.save();
        }
      }

      // Sync user.pendingTasks
      await syncUserPendingForTask(t, null);

      return created(res, t);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      return fail(res, e);
    }
  });

  // GET /api/tasks/:id  (supports ?select=)
  r.get('/:id', async (req, res) => {
    try {
      const select = req.query.select ? parseJSON(req.query.select) : undefined;
      let q = Task.findById(req.params.id);
      if (select) q = q.select(select);
      const doc = await q.exec();
      if (!doc) return notFound(res, 'Task not found');
      return ok(res, doc);
    } catch (e) {
      if (e instanceof SyntaxError) return bad(res, 'Invalid JSON in select');
      return fail(res, e);
    }
  });

  // PUT /api/tasks/:id  (replace; must include name & deadline)
  r.put('/:id', async (req, res) => {
    try {
      const id = req.params.id;
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

      // Replace (set all fields explicitly)
      before.name = name;
      before.description = description ?? '';
      before.deadline = deadline;
      before.completed = completed ?? false;

      // assignment fields + sensible defaults
      before.assignedUser = assignedUser ?? '';
      if (before.assignedUser) {
        const u = await User.findById(before.assignedUser);
        before.assignedUserName = assignedUserName ?? (u ? u.name : 'unassigned');
      } else {
        before.assignedUserName = 'unassigned';
      }

      const task = await before.save();

      // Two-way sync w/ users’ pendingTasks
      await syncUserPendingForTask(task, prevAssignedUser);

      return ok(res, task);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      return fail(res, e);
    }
  });

  // DELETE /api/tasks/:id  (remove from assignedUser.pendingTasks; return 204)
  r.delete('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const task = await Task.findById(id);
      if (!task) return notFound(res, 'Task not found');

      // Pull from assigned user's pendingTasks if needed
      if (task.assignedUser) {
        await User.updateOne(
          { _id: String(task.assignedUser) },
          { $pull: { pendingTasks: String(task._id) } }
        );
      }

      await task.deleteOne();
      return res.status(204).send(); // no content
    } catch (e) {
      return fail(res, e);
    }
  });

  router.use('/tasks', r);
  return router;
};

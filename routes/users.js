// routes/users.js
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');

module.exports = function (router) {
  const r = express.Router();

  // Helpers
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

  // GET /api/users
  r.get('/', async (req, res) => {
    try {
      const where = req.query.where ? parseJSON(req.query.where) : {};
      const sort = req.query.sort ? parseJSON(req.query.sort) : undefined;
      const select = req.query.select ? parseJSON(req.query.select) : undefined;
      const skip = toInt(req.query.skip, 0);
      const limit =
        req.query.limit !== undefined ? toInt(req.query.limit) : undefined; // unlimited by default for users
      const count = asBool(req.query.count);

      if (count) {
        const c = await User.countDocuments(where || {});
        return ok(res, c, 'OK');
      }

      let q = User.find(where || {});
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

  // POST /api/users
  r.post('/', async (req, res) => {
    try {
      const { name, email, pendingTasks } = req.body || {};
      if (!name || !email) return bad(res, 'Name and email are required');

      const dup = await User.findOne({ email: String(email).toLowerCase() });
      if (dup) return bad(res, 'A user with this email already exists');

      const user = await User.create({
        name,
        email,
        pendingTasks: Array.isArray(pendingTasks) ? pendingTasks : [],
      });

      if (Array.isArray(user.pendingTasks) && user.pendingTasks.length) {
        await Task.updateMany(
          { _id: { $in: user.pendingTasks }, completed: false },
          { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
        );
      }

      return created(res, user);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      if (e.code === 11000) return bad(res, 'A user with this email already exists');
      return fail(res, e);
    }
  });

  // GET /api/users/:id (supports ?select=)
  r.get('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'User not found');

      const select = req.query.select ? parseJSON(req.query.select) : undefined;
      let q = User.findById(id);
      if (select) q = q.select(select);
      const doc = await q.exec();
      if (!doc) return notFound(res, 'User not found');
      return ok(res, doc);
    } catch (e) {
      if (e instanceof SyntaxError) return bad(res, 'Invalid JSON in select');
      return fail(res, e);
    }
  });

  // PUT /api/users/:id (replace; requires name & email)
  r.put('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'User not found');

      const { name, email, pendingTasks } = req.body || {};
      if (!name || !email) return bad(res, 'Name and email are required');

      const dup = await User.findOne({
        email: String(email).toLowerCase(),
        _id: { $ne: id },
      });
      if (dup) return bad(res, 'A user with this email already exists');

      const before = await User.findById(id);
      if (!before) return notFound(res, 'User not found');

      before.name = name;
      before.email = email;
      before.pendingTasks = Array.isArray(pendingTasks) ? pendingTasks : [];
      const user = await before.save();

      await Task.updateMany(
        { _id: { $in: user.pendingTasks }, completed: false },
        { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
      );

      const nowSet = new Set(user.pendingTasks);
      const toUnassign = await Task.find({
        assignedUser: String(user._id),
        completed: false,
      }).select({ _id: 1 });
      const dropIds = toUnassign
        .map((t) => String(t._id))
        .filter((tid) => !nowSet.has(tid));

      if (dropIds.length) {
        await Task.updateMany(
          { _id: { $in: dropIds } },
          { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
      }

      return ok(res, user);
    } catch (e) {
      if (e.name === 'ValidationError') return bad(res, e.message);
      return fail(res, e);
    }
  });

  // DELETE /api/users/:id
  r.delete('/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidId(id)) return notFound(res, 'User not found');

      const user = await User.findById(id);
      if (!user) return notFound(res, 'User not found');

      await Task.updateMany(
        { assignedUser: String(id), completed: false },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
      );

      await user.deleteOne();
      return res.status(204).send();
    } catch (e) {
      return fail(res, e);
    }
  });

  router.use('/users', r);
  return router;
};

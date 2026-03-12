import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../../models/User.js';

const router = Router();

router.post('/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!name || !email || !password) return res.status(400).json({ message: 'Missing fields' });
    const existing = await User.findOne({ email: normalizedEmail }).lean();
    if (existing) return res.status(400).json({ message: 'Email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ name, email: normalizedEmail, passwordHash, hasSeenOnboarding: false });
    return res.json({ message: 'ok' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;



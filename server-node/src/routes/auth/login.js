import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../../models/User.js';
import { Token } from '../../models/Token.js';

const router = Router();

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!email || !password) return res.status(400).json({ message: 'Missing fields' });
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ sub: user._id.toString(), email: normalizedEmail }, process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '7d' });
    await Token.create({ token, email: normalizedEmail });
    return res.json({ token, hasSeenOnboarding: !!user.hasSeenOnboarding });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;



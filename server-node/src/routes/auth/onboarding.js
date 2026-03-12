import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../../models/User.js';

const router = Router();

// POST /auth/onboarding/seen
// Requires Authorization: Bearer <jwt>
router.post('/auth/onboarding/seen', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Missing token' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
    } catch {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const userId = payload.sub;
    if (!userId) return res.status(400).json({ message: 'Invalid token payload' });

    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: { hasSeenOnboarding: true } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ message: 'User not found' });

    return res.json({ message: 'ok', hasSeenOnboarding: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: 'Server error' });
  }
});

export default router;



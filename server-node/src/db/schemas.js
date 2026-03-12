import mongoose from 'mongoose';

export const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    hasSeenOnboarding: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const TokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, index: true },
    email: { type: String, required: true }
  },
  { timestamps: true }
);



import mongoose from 'mongoose';
import { UserSchema } from '../db/schemas.js';

export const User = mongoose.models.User || mongoose.model('User', UserSchema);



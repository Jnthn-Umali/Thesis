import mongoose from 'mongoose';
import { TokenSchema } from '../db/schemas.js';

export const Token = mongoose.models.Token || mongoose.model('Token', TokenSchema);



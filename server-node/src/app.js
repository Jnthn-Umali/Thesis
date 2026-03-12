import express from 'express';
import cors from 'cors';

import healthRouter from './routes/health.js';
import signupRouter from './routes/auth/signup.js';
import loginRouter from './routes/auth/login.js';
import onboardingRouter from './routes/auth/onboarding.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use(healthRouter);
  app.use(signupRouter);
  app.use(loginRouter);
  app.use(onboardingRouter);

  return app;
}



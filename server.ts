import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './backend/routes.ts';
import { DERIVATIVES_DIR, ensureStorageDirs } from './backend/storage.ts';
import { initializeDatabase } from './backend/db.ts';

async function startServer() {
  ensureStorageDirs();
  initializeDatabase();

  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Mount REST API
  app.use('/api', apiRouter);

  // Serve analysis derivatives safely (read-only derived previews, ELA maps, video frames, spectrograms)
  app.use(
    '/derivatives',
    express.static(DERIVATIVES_DIR, {
      dotfiles: 'deny',
      index: false,
      fallthrough: false,
    })
  );

  // Error handler for API & static derivatives
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (req.path.startsWith('/api')) {
        return res.status(err?.status || 500).json({
          success: false,
          data: null,
          error: err?.message || 'Internal server error',
        });
      }
      if (req.path.startsWith('/derivatives')) {
        return res.status(404).send('Derived artifact not found');
      }
      return next(err);
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TruthLens X server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TruthLens X server:', err);
  process.exit(1);
});

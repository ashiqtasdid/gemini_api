import { Router, Request, Response } from 'express';
import { handleTestRoute } from '../controllers';

const router = Router();

export function setRoutes(app: Router) {
    app.get('/test', handleTestRoute);
}

export default router;
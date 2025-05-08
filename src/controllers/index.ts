import { Request, Response } from 'express';

export const handleTestRoute = (req: Request, res: Response): void => {
    res.send('Hello World! The API is working');
};
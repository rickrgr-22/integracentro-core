import express, { Request, Response } from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', service: 'iam-service' });
});

app.listen(PORT, () => {
  console.log(`IAM Service listening on port ${PORT}`);
});

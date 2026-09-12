import express, { Request, Response } from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', service: 'scoring-engine' });
});

app.listen(PORT, () => {
  console.log(`Scoring Engine listening on port ${PORT}`);
});

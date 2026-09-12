import express, { Request, Response } from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'UP', service: 'vault-manager' });
});

app.listen(PORT, () => {
  console.log(`Vault Manager listening on port ${PORT}`);
});

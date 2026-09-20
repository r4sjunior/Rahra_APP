// Chave pública do Clerk para o navegador (não é segredo).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  const key = process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!key) return res.status(500).json({ error: 'CLERK_PUBLISHABLE_KEY não configurada.' });
  res.status(200).json({ clerkPublishableKey: key });
}

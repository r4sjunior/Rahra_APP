import { authenticate, route } from '../lib/auth.js';

// Quem sou eu e qual é o meu papel.
export const make = auth =>
  route(async req => {
    const { user } = await auth(req);
    return { clerk_id: user.clerk_id, email: user.email, name: user.name, role: user.role };
  });
export default make(authenticate);

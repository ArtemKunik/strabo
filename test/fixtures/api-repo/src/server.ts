import { deleteUser, showUser } from './users';

app.get('/users/:id', requireAuth, showUser);
app.delete('/users/:id', deleteUser);
app.get('/health', (req, res) => res.send('ok'));

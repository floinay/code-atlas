import { app } from './app';
import { startTaskJobs } from './modules/tasks/tasks.jobs';

startTaskJobs();
app.listen(Number(process.env.PORT ?? 3000));

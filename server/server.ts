import { createApp } from './app';
import { assertRequiredEnv } from './config';

assertRequiredEnv();
const port = Number(process.env.PORT) || 8080;
createApp().listen(port, () => {
  console.log(`cams listening on port ${port}`);
});

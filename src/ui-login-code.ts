import { createUiLoginCode } from "./guidance-ui.js";
import { loadConfig } from "./config.js";
const config=loadConfig();
console.log(await createUiLoginCode(config.dataDirectory));

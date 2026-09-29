const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

writeFileSync(join(__dirname, 'install-ran.txt'), 'lifecycle scripts were executed\n', 'utf8');

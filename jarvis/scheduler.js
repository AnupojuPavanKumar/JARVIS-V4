'use strict';

// Compatibility entry point. The implementation lives in core/scheduler; this
// module only re-exports it so older imports cannot create a second scheduler.
module.exports = require('./core/scheduler/scheduler');

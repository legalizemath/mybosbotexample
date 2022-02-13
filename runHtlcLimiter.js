// just uses htlcLimiter.js so I don't have to keep 2 versions of same code around
// runs it via `npm link balanceofsatoshis && node runHtlcLimiter`

import htlcLimiter from './htlcLimiter.js'

// just run htlcLimiter now
htlcLimiter()

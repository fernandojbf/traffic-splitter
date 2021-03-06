'use strict'

const geoipLite = require('geoip-lite')
const MobileDetect = require('mobile-detect')

const NOT_FOUND = 'NOT_FOUND'

const evaluateRules = (criteria, req, options, userRules, logger) => {
  if (!criteria) { return true }

  if (!Object.keys(criteria).every(key => {
    // handle operators AND and OR only after the loop
    // at this point ruleset was already evaluated
    if (['and', 'or', 'ruleset'].indexOf(key) >= 0) { return true }

    // first search for the key in userRules - this allows user to override splitterRules
    if (userRules[key]) {
      const result = userRules[key](criteria[key], req)
      const type = typeof result
      if (type !== 'boolean') {
        logger.warn(`Custom rule '${key}' ignored! It returned ${result} (type: ${type}) when it should've returned a boolean.`)
        return true // ignore rule
      }
      return result
    } else if (splitterRules[key]) {
      return splitterRules[key](criteria[key], req, options)
    } else {
      logger.warn(`Callback to evaluate rule '${key}' not found. Rule ignored.`)
      return true // ignore rule
    }
  })) {
    return false
  }

  // array of rules AND is treated as a single rule and not as the whole
  if (criteria.and && criteria.and.length > 0) {
    if (!criteria.and.every(single => evaluateRules(single, req, options, userRules, logger))) {
      return false
    }
  }

  // array of rules OR is treated as a single rule and not as the whole
  if (criteria.or && criteria.or.length > 0) {
    if (!criteria.or.some(single => evaluateRules(single, req, options, userRules, logger))) {
      return false
    }
  }

  return true
}

module.exports = { evaluateRules }

const evaluateHost = (criteria, req) => {
  if (criteria.length === 0) { return true }
  if (!req.headers || !req.headers.host) { return false }

  return criteria.indexOf(req.headers.host) >= 0
}

const evaluatePath = (criteria, req) => {
  if (criteria.length === 0) { return true }
  if (!req.url) { return false }

  return criteria.some(path => req.url.match(path))
}

// this functions picks the last 2 chars of the browserId cookie, converts them from hexadecimal to decimal
// and with that value returns a value from 0 to 100
// the same bid will always get the same return
const calculateBucket = bid => Math.round(parseInt(bid.substring(bid.length - 2), 16) / 255 * 100)

// evaluates the bucket based on the browserId cookie
const evaluateBucket = (criteria, req, options) => {
  if (criteria.length === 0) { return true }
  if (!options.bucket) { options.bucket = calculateBucket(req.bid) }

  // tell the request to emit the Browser ID.
  // this ensure that BrowserIds are only emitted if there are actually buckets being analysed
  req.emitBid = true

  return criteria.some(bucket => options.bucket >= bucket.min && options.bucket <= bucket.max)
}

const evaluateCookie = (criteria, req) => {
  if (criteria.length === 0) { return true }
  if (!req.cookies) { return false }

  return criteria.some(cookie => {
    if (!req.cookies[cookie.name]) { return false }
    return req.cookies[cookie.name] === cookie.value
  })
}

const evaluteUserAgent = (criteria, req) => {
  if (criteria.length === 0) { return true }
  if (!req.headers || !req.headers['user-agent']) { return false }

  return criteria.some(agent => req.headers['user-agent'].match(agent))
}

const getGeoIp = req => {
  const lookup = geoipLite.lookup(
    (req.params && req.params.splitterIP) ||
    req.headers['X-Forwarded-For'] || // to allow proxies
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket && req.connection.socket.remoteAddress) // only this one will work on https
  )

  return lookup ? [lookup.country, lookup.region, lookup.city].join('.') : NOT_FOUND
}

const evaluateGeoip = (criteria, req, options) => {
  if (criteria.length === 0) { return true }
  if (!options.geo) { options.geo = getGeoIp(req) }
  if (options.geo === NOT_FOUND) { return false }

  return criteria.some(g => {
    if (options.geo === g) { return true }
    if (g[g.length - 1] !== '.') { return false }
    return options.geo.split('.')[0] === g.split('.')[0]
  })
}

const evaluateDeviceDevice = (mobileDetect, {device, type}) => {
  if (!device) { return true }
  switch (device) {
    case 'desktop': return !mobileDetect.mobile()
    case 'phone':
    case 'tablet':
    case 'mobile':
      const result = mobileDetect[device]()
      return type ? result === type : !!result
    default: return true
  }
}

const evaluateDeviceBrowserAndVersion = (mobileDetect, {browser, version}) => {
  if (!browser) { return true }

  const currentVersion = mobileDetect.version(browser)
  if (!currentVersion) { return false }

  version = version || {}
  version.from = version.from || 0
  version.to = version.to || Infinity

  return currentVersion >= version.from && currentVersion <= version.to
}

const evaluateDevice = (criteria, req, options) => {
  if (criteria.length === 0) { return true }
  if (!req.headers || !req.headers['user-agent']) { return false }
  if (!options.device) { options.device = new MobileDetect(req.headers['user-agent']) }

  return criteria.some(d => [evaluateDeviceDevice, evaluateDeviceBrowserAndVersion].every(fn => fn(options.device, d)))
}

// user is considered a visitor when no bid cookie is set
const evaluateVisitor = (criteria, req) => {
  criteria = !!criteria
  if (!req.cookies) { return criteria }

  return req.cookies.bid ? !criteria : criteria
}

const splitterRules = {
  host: evaluateHost,
  path: evaluatePath,
  bucket: evaluateBucket,
  cookie: evaluateCookie,
  agent: evaluteUserAgent,
  geoip: evaluateGeoip,
  device: evaluateDevice,
  visitor: evaluateVisitor
}

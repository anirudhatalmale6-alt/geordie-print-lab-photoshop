/**
 * Licence handling for the Geordie Print Lab Photoshop plugin.
 *
 * The plugin cannot log anybody in - there is no browser session inside
 * Photoshop - so the key IS the credential. It is checked against the shop on
 * every start, not once at install, which is what makes a lapsed membership
 * actually stop the plugin.
 *
 * Deliberately free of any Photoshop API so it can be tested without one.
 */

'use strict';

var ENDPOINT = 'https://geordieprintco.co.uk/wp-json/bpt/v1/licence';

/* How long we will trust a good answer if the shop cannot be reached. Someone
   on a train with no signal should not lose the tool mid-job; someone who
   cancelled six months ago should not keep it forever. */
var GRACE_DAYS = 14;

var K_KEY = 'printlab.licence.key';
var K_DEVICE = 'printlab.device.id';
var K_LAST_OK = 'printlab.licence.lastOk';
var K_LAST_INFO = 'printlab.licence.lastInfo';

/**
 * Storage. UXP gives us secureStorage for credentials; plain localStorage is
 * the fallback for the test harness and for hosts where secureStorage is not
 * available. Everything here is async because secureStorage is.
 */
function makeStore( backing ) {
	return {
		get: function ( k ) {
			return Promise.resolve()
				.then( function () {
					return backing.getItem( k );
				} )
				.then( function ( v ) {
					if ( v === null || v === undefined ) {
						return '';
					}
					/* secureStorage hands back a Uint8Array, localStorage a string. */
					if ( typeof v === 'string' ) {
						return v;
					}
					return String.fromCharCode.apply( null, v );
				} )
				.catch( function () {
					return '';
				} );
		},
		set: function ( k, v ) {
			return Promise.resolve()
				.then( function () {
					return backing.setItem( k, v );
				} )
				.catch( function () {
					return undefined;
				} );
		},
		remove: function ( k ) {
			return Promise.resolve()
				.then( function () {
					return backing.removeItem( k );
				} )
				.catch( function () {
					return undefined;
				} );
		}
	};
}

/**
 * Tidy a key the way the customer will actually type it: lower case, spaces,
 * missing dashes, a stray newline off the end of a copy and paste.
 *
 * The server normalises the same way, so the two meet in the middle.
 */
function normalise( key ) {
	return String( key || '' ).toUpperCase().replace( /[^A-Z0-9]/g, '' );
}

function pretty( key ) {
	var n = normalise( key );
	var out = [];
	var i;

	if ( n.indexOf( 'GPL' ) === 0 ) {
		n = n.slice( 3 );
	}

	for ( i = 0; i < n.length; i += 5 ) {
		out.push( n.slice( i, i + 5 ) );
	}

	return 'GPL-' + out.join( '-' );
}

/**
 * Does this even look like one of our keys? Worth checking before spending a
 * network round trip and, more to the point, before spending one of the
 * customer's twenty attempts on an obvious typo.
 */
function looksLikeKey( key ) {
	var n = normalise( key );

	if ( n.indexOf( 'GPL' ) === 0 ) {
		n = n.slice( 3 );
	}

	/* 20 characters from the server's alphabet, which has no O, 0, I or 1 in
	   it precisely because people read these off a screen. */
	return /^[A-HJ-NP-Z2-9]{20}$/.test( n );
}

function today() {
	return new Date().toISOString().slice( 0, 10 );
}

function daysBetween( a, b ) {
	var ms = Date.parse( b + 'T00:00:00Z' ) - Date.parse( a + 'T00:00:00Z' );

	if ( isNaN( ms ) ) {
		return Infinity;
	}

	return Math.round( ms / 86400000 );
}

/**
 * A stable identifier for this installation.
 *
 * Random, stored once. Deliberately NOT anything real about the machine - we
 * have no business collecting a serial number or a user name, and a random
 * value counts installations just as well.
 */
function deviceId( store, randomHex ) {
	return store.get( K_DEVICE ).then( function ( existing ) {
		if ( existing ) {
			return existing;
		}

		var id = randomHex( 16 );

		return store.set( K_DEVICE, id ).then( function () {
			return id;
		} );
	} );
}

/**
 * Ask the shop about a key.
 *
 * Returns a plain object - never throws - because every caller wants to show
 * the customer something rather than a stack trace.
 */
function ask( fetchImpl, key, device ) {
	var controller = typeof AbortController === 'function' ? new AbortController() : null;
	var timer = null;

	if ( controller ) {
		timer = setTimeout( function () {
			controller.abort();
		}, 15000 );
	}

	return fetchImpl( ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( { key: normalise( key ), device: device } ),
		signal: controller ? controller.signal : undefined
	} )
		.then( function ( res ) {
			return res.json().then( function ( body ) {
				return { status: res.status, body: body || {} };
			} );
		} )
		.then( function ( r ) {
			if ( 429 === r.status ) {
				return { ok: false, offline: false, reason: 'too_many_attempts' };
			}

			if ( 200 !== r.status ) {
				/* Not a refusal - the shop is unwell, or something in between
				   us and it is. Treated as offline so a customer is not locked
				   out by our own server having a bad afternoon. */
				return { ok: false, offline: true, reason: 'http_' + r.status };
			}

			return {
				ok: !! r.body.valid,
				offline: false,
				reason: r.body.reason || ( r.body.valid ? 'ok' : 'refused' ),
				plan: r.body.plan || '',
				expires: r.body.expires || '',
				trial: !! r.body.trial
			};
		} )
		.catch( function ( e ) {
			return {
				ok: false,
				offline: true,
				reason: e && 'AbortError' === e.name ? 'timeout' : 'network'
			};
		} )
		.then( function ( out ) {
			if ( timer ) {
				clearTimeout( timer );
			}

			return out;
		} );
}

/**
 * What the customer is told. One place, so the panel never has to interpret a
 * reason code and no raw code ever reaches the screen.
 */
function explain( reason ) {
	var map = {
		unknown_key: 'That key was not recognised. Check it against the one on your membership page.',
		membership_inactive: 'Your membership is not active at the moment, so the plugin is switched off. It will come back on by itself once a payment goes through.',
		too_many_installs: 'This key is already in use on two computers. Sign out of one on your membership page, then try again.',
		key_revoked: 'That key has been switched off by Geordie Print Co. Get in touch with them if that is not what you expected.',
		key_expired: 'That key has run out. Get in touch with Geordie Print Co if you need it extending.',
		too_many_attempts: 'Too many tries in a short space of time. Give it a quarter of an hour and try again.',
		malformed: 'That does not look like a Print Lab key. They look like GPL-XXXXX-XXXXX-XXXXX-XXXXX.',
		timeout: 'The shop did not answer in time.',
		network: 'Could not reach the shop. Check the internet connection.'
	};

	if ( map[ reason ] ) {
		return map[ reason ];
	}

	if ( 0 === String( reason ).indexOf( 'http_' ) ) {
		return 'The shop answered with an error. Try again in a few minutes.';
	}

	return 'The key could not be checked.';
}

/**
 * The whole start-up decision, in one call.
 *
 * @param {Object} deps store, fetchImpl, randomHex, now (Y-m-d)
 * @param {string} candidate A key the customer has just typed, or '' to use
 *                           whatever is already stored.
 * @return {Promise<Object>} { state, message, info }
 *         state is one of: 'no-key' | 'ok' | 'grace' | 'refused' | 'offline'
 */
function check( deps, candidate ) {
	var store = deps.store;
	var now = deps.now || today();
	var typed = candidate !== undefined && candidate !== null && '' !== candidate;

	return store.get( K_KEY ).then( function ( stored ) {
		var key = typed ? candidate : stored;

		if ( ! key ) {
			return { state: 'no-key', message: '', info: null };
		}

		if ( ! looksLikeKey( key ) ) {
			return { state: 'refused', message: explain( 'malformed' ), info: null };
		}

		return deviceId( store, deps.randomHex ).then( function ( device ) {
			return ask( deps.fetchImpl, key, device ).then( function ( r ) {
				if ( r.ok ) {
					var info = {
						plan: r.plan,
						expires: r.expires,
						trial: r.trial
					};

					return Promise.all( [
						store.set( K_KEY, normalise( key ) ),
						store.set( K_LAST_OK, now ),
						store.set( K_LAST_INFO, JSON.stringify( info ) )
					] ).then( function () {
						return { state: 'ok', message: '', info: info };
					} );
				}

				if ( ! r.offline ) {
					/*
					 * A definite no from the shop. The stored key is only
					 * cleared when the shop says it is not a key at all -
					 * a lapsed membership keeps its key, because it starts
					 * working again the moment they pay and nobody should
					 * have to type it in twice.
					 */
					var clear = 'unknown_key' === r.reason
						? store.remove( K_KEY )
						: Promise.resolve();

					return clear
						.then( function () {
							return store.remove( K_LAST_OK );
						} )
						.then( function () {
							return {
								state: 'refused',
								reason: r.reason,
								message: explain( r.reason ),
								info: null
							};
						} );
				}

				/* Could not reach the shop. Fall back to the last good answer,
				   if it is recent enough. */
				return store.get( K_LAST_OK ).then( function ( last ) {
					if ( ! last ) {
						return {
							state: 'offline',
							reason: r.reason,
							message: explain( r.reason ),
							info: null
						};
					}

					var age = daysBetween( last, now );

					if ( age < 0 || age > GRACE_DAYS ) {
						return {
							state: 'offline',
							reason: r.reason,
							message: 'The shop has not been reachable for a while, so the plugin has stopped. ' + explain( r.reason ),
							info: null
						};
					}

					return store.get( K_LAST_INFO ).then( function ( raw ) {
						var info = null;

						try {
							info = raw ? JSON.parse( raw ) : null;
						} catch ( e ) {
							info = null;
						}

						return {
							state: 'grace',
							message: 'Working offline. ' + ( GRACE_DAYS - age ) + ' days left before the plugin needs to check in with the shop.',
							info: info
						};
					} );
				} );
			} );
		} );
	} );
}

function signOut( store ) {
	return Promise.all( [
		store.remove( K_KEY ),
		store.remove( K_LAST_OK ),
		store.remove( K_LAST_INFO )
	] );
}

module.exports = {
	ENDPOINT: ENDPOINT,
	GRACE_DAYS: GRACE_DAYS,
	makeStore: makeStore,
	normalise: normalise,
	pretty: pretty,
	looksLikeKey: looksLikeKey,
	explain: explain,
	deviceId: deviceId,
	ask: ask,
	check: check,
	signOut: signOut
};

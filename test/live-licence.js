/**
 * The plugin's own licence code, against the real shop.
 *
 * The suite in run.js uses a fetch I control, which proves the logic but not
 * that it agrees with the actual endpoint - the shape of a reply, the reason
 * strings, the status codes, Cloudflare in the middle. This one uses the real
 * thing.
 *
 * Usage: node test/live-licence.js <real-key>
 * The caller is responsible for creating and deleting the test member.
 */

'use strict';

const path = require( 'path' );
const licence = require( path.join( __dirname, '..', 'licence.js' ) );

const KEY = process.argv[ 2 ];

let ok = 0;
const fails = [];

function check( label, cond ) {
	if ( cond ) {
		ok++;
		console.log( '  ok    ' + label );
	} else {
		fails.push( label );
		console.log( '  FAIL  ' + label );
	}
}

function memStore( seed ) {
	const m = Object.assign( {}, seed || {} );
	return licence.makeStore( {
		getItem: ( k ) => ( k in m ? m[ k ] : null ),
		setItem: ( k, v ) => { m[ k ] = String( v ); },
		removeItem: ( k ) => { delete m[ k ]; }
	} );
}

const randomHex = ( n ) => {
	let s = '';
	for ( let i = 0; i < n * 2; i++ ) {
		s += '0123456789abcdef'[ Math.floor( Math.random() * 16 ) ];
	}
	return s;
};

( async () => {
	if ( ! KEY ) {
		console.log( 'no key given' );
		process.exit( 1 );
	}

	console.log( 'endpoint: ' + licence.ENDPOINT );
	console.log( 'key:      ' + licence.pretty( KEY ) + '\n' );

	const deps = { fetchImpl: fetch, randomHex, now: new Date().toISOString().slice( 0, 10 ) };

	/* --- the real key, over the real network ----------------------- */
	const store = memStore();
	const r = await licence.check( Object.assign( { store }, deps ), KEY );
	console.log( '  ' + JSON.stringify( r ) );
	check( 'a real key is accepted by the real shop', r.state === 'ok' );
	check( 'and the plan comes back', !! ( r.info && r.info.plan ) );
	check( 'and it is stored for next time',
		( await store.get( 'printlab.licence.key' ) ) === licence.normalise( KEY ) );

	/* --- restarting the plugin: no key typed, uses the stored one --- */
	const r2 = await licence.check( Object.assign( { store }, deps ) );
	check( 'a restart re-checks the stored key and passes', r2.state === 'ok' );

	/* --- a key that is well-formed but not real --------------------- */
	const bogus = memStore();
	const rb = await licence.check(
		Object.assign( { store: bogus }, deps ),
		'GPL-AAAAA-BBBBB-CCCCC-DDDDD'
	);
	console.log( '  ' + JSON.stringify( rb ) );
	check( 'a made-up key is refused by the real shop', rb.state === 'refused' );
	check( 'and the customer gets a sentence, not a code',
		typeof rb.message === 'string' && rb.message.length > 20 && rb.message.indexOf( '_' ) === -1 );
	check( 'and nothing is stored', ( await bogus.get( 'printlab.licence.key' ) ) === '' );

	/* --- the third machine ----------------------------------------- */
	/* The real key has now been seen on one device (this run). Two more
	   distinct devices should take the second slot and then be refused. */
	const d2 = await licence.ask( fetch, KEY, randomHex( 16 ) );
	const d3 = await licence.ask( fetch, KEY, randomHex( 16 ) );
	console.log( '  second device: ' + JSON.stringify( d2 ) );
	console.log( '  third device:  ' + JSON.stringify( d3 ) );
	check( 'a second machine is allowed', d2.ok === true );
	check( 'a third machine is refused', d3.ok === false );
	check( 'and the plugin has a sentence ready for it',
		licence.explain( d3.reason ).indexOf( 'two computers' ) !== -1 );

	/* --- the reply must not describe the person --------------------- */
	const raw = await fetch( licence.ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( { key: licence.normalise( KEY ), device: '' } )
	} );
	const body = await raw.json();
	console.log( '  raw reply: ' + JSON.stringify( body ) );
	const leaky = Object.keys( body ).filter( ( k ) =>
		[ 'email', 'user_email', 'login', 'user_login', 'id', 'user_id', 'name', 'display_name' ].indexOf( k ) !== -1 );
	check( 'the reply names nobody', leaky.length === 0 );
	check( 'an empty device does not take a slot', body.valid === true );

	if ( ok + fails.length < 12 ) {
		fails.push( 'only ' + ( ok + fails.length ) + ' checks ran, expected at least 12' );
	}

	console.log( '\n' + ( fails.length ? fails.length + ' FAILED of ' + ( ok + fails.length ) : 'LIVE LICENCE: ALL ' + ok + ' PASSED' ) );
	fails.forEach( ( f ) => console.log( ' - ' + f ) );
	process.exit( fails.length ? 1 : 0 );
} )().catch( ( e ) => {
	console.log( 'threw: ' + e.stack );
	process.exit( 1 );
} );

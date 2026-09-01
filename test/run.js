/**
 * Tests for everything in the plugin that is not Photoshop itself.
 *
 * Run: node test/run.js
 *
 * What this CANNOT test is getPixels/putPixels against a real document - that
 * needs Photoshop, which is not on this machine. Everything up to and
 * including the call arguments handed to Photoshop is covered here, and the
 * bridge is deliberately the only file with Photoshop in it so the boundary
 * is a real one rather than a claim.
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const ROOT = path.join( __dirname, '..' );
const WEB = path.join( __dirname, '..', '..', 'dtx' );

const licence = require( path.join( ROOT, 'licence.js' ) );
const studio = require( path.join( ROOT, 'studio.js' ) );
const engine = require( path.join( ROOT, 'engine.js' ) );
const { Bridge } = require( path.join( ROOT, 'bridge.js' ) );

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

function section( name ) {
	console.log( '\n' + name );
}

/* ------------------------------------------------------------------ */
/* 1. The plugin must not drift away from the website                  */
/* ------------------------------------------------------------------ */

section( 'plugin settings vs the website' );

const appSrc = fs.readFileSync( path.join( WEB, 'dtx.js' ), 'utf8' );

/* The web app's defaults, lifted out of its source rather than retyped -
   retyping is exactly how the two would come to disagree. */
function webDefaults() {
	const start = appSrc.indexOf( 'dpi: 300,' );
	if ( start === -1 ) {
		throw new Error( 'could not find the web defaults' );
	}
	const open = appSrc.lastIndexOf( '{', start );
	let depth = 0;
	let end = -1;
	for ( let i = open; i < appSrc.length; i++ ) {
		if ( appSrc[ i ] === '{' ) depth++;
		else if ( appSrc[ i ] === '}' ) {
			depth--;
			if ( depth === 0 ) { end = i; break; }
		}
	}
	// eslint-disable-next-line no-eval
	return eval( '(' + appSrc.slice( open, end + 1 ) + ')' );
}

function webEngineKeys() {
	const m = appSrc.match( /function settingsForWorker\s*\(\s*\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};/ );
	if ( ! m ) {
		throw new Error( 'could not find settingsForWorker' );
	}
	return m[ 1 ]
		.split( '\n' )
		.map( ( l ) => ( l.match( /^\s*([A-Za-z0-9_]+)\s*:/ ) || [] )[ 1 ] )
		.filter( Boolean );
}

const wd = webDefaults();
const wk = webEngineKeys();
const pd = studio.defaults();

check( 'the web defaults were found (' + Object.keys( wd ).length + ' keys)', Object.keys( wd ).length > 30 );
check( 'the web engine key list was found (' + wk.length + ' keys)', wk.length > 20 );

/* Every key the engine is sent must exist in both default sets, with the same
   value. Keys the web app has and the plugin does not are fine - the plugin
   has no upscaler - but a shared key that DISAGREES is a
   customer getting two different results from the same numbers. */
const shared = studio.ENGINE_KEYS.filter( ( k ) => k in wd );

/* Two of the engine keys are worked out from other settings every time rather
   than stored, so neither side has a default for them and neither should. They
   still have to be SENT by both, which the key-list check above covers. */
const stored = studio.ENGINE_KEYS.filter(
	( k ) => studio.DERIVED_KEYS.indexOf( k ) === -1 );

check( 'the plugin sends the same keys the website does', studio.ENGINE_KEYS.length === wk.length &&
	studio.ENGINE_KEYS.every( ( k ) => wk.indexOf( k ) !== -1 ) );
check( 'every stored engine key has a web default', shared.length === stored.length );
check( 'and the derived ones are stored by neither side',
	studio.DERIVED_KEYS.every( ( k ) => ! ( k in wd ) && ! ( k in pd ) ) );

const disagree = shared.filter( ( k ) => JSON.stringify( wd[ k ] ) !== JSON.stringify( pd[ k ] ) );
check( 'no shared default disagrees' + ( disagree.length ? ' (' + disagree.join( ', ' ) + ')' : '' ),
	disagree.length === 0 );

/* And the engine file itself must be the same one the website serves. */
const mine = fs.readFileSync( path.join( ROOT, 'engine.js' ) );
const theirs = fs.readFileSync( path.join( WEB, 'dtx-engine.js' ) );
check( 'the bundled engine is byte-identical to the website\'s', mine.equals( theirs ) );
check( 'the engine publishes the API version the plugin expects', engine.ENGINE_API === 1 );

/* ------------------------------------------------------------------ */
/* 2. Licence key handling                                             */
/* ------------------------------------------------------------------ */

section( 'key formatting' );

check( 'a key typed in lower case with spaces is accepted',
	licence.looksLikeKey( ' gpl-n266a 3j2rr-b54zr 6cygc\n' ) );
check( 'and comes out tidy',
	licence.pretty( ' gpl-n266a 3j2rr-b54zr 6cygc\n' ) === 'GPL-N266A-3J2RR-B54ZR-6CYGC' );
check( 'a key with a letter the alphabet does not use is rejected',
	! licence.looksLikeKey( 'GPL-O0I1A-3J2RR-B54ZR-6CYGC' ) );
check( 'a short key is rejected', ! licence.looksLikeKey( 'GPL-N266A-3J2RR' ) );
check( 'an empty key is rejected', ! licence.looksLikeKey( '' ) );
check( 'no reason code ever reaches the customer',
	[ 'unknown_key', 'membership_inactive', 'too_many_installs', 'nonsense_code' ]
		.every( ( r ) => licence.explain( r ).indexOf( '_' ) === -1 ) );

/* --- a store and a fetch we control -------------------------------- */

function memStore( seed ) {
	const m = Object.assign( {}, seed || {} );
	return licence.makeStore( {
		getItem: ( k ) => ( k in m ? m[ k ] : null ),
		setItem: ( k, v ) => { m[ k ] = String( v ); },
		removeItem: ( k ) => { delete m[ k ]; },
		_dump: () => m
	} );
}

function fakeFetch( plan ) {
	const calls = [];
	const f = ( url, opts ) => {
		calls.push( { url, body: JSON.parse( opts.body ) } );
		const step = plan.shift();
		if ( step === 'network' ) {
			return Promise.reject( Object.assign( new Error( 'down' ), { name: 'TypeError' } ) );
		}
		return Promise.resolve( {
			status: step.status,
			json: () => Promise.resolve( step.body )
		} );
	};
	f.calls = calls;
	return f;
}

const randomHex = ( n ) => 'd'.repeat( n * 2 );
const KEY = 'GPL-N266A-3J2RR-B54ZR-6CYGC';

const run = [];

section( 'the start-up decision' );

run.push( ( async () => {
	const store = memStore();
	const r = await licence.check( { store, fetchImpl: fakeFetch( [] ), randomHex, now: '2026-08-30' } );
	check( 'with no key stored it asks for one', r.state === 'no-key' );
} )() );

run.push( ( async () => {
	const store = memStore();
	const f = fakeFetch( [ { status: 200, body: { valid: true, reason: 'ok', plan: 'month', expires: '2026-09-30', trial: false } } ] );
	const r = await licence.check( { store, fetchImpl: f, randomHex, now: '2026-08-30' }, KEY );
	check( 'a good key is accepted', r.state === 'ok' );
	check( 'the key is sent normalised', f.calls[ 0 ].body.key === 'GPLN266A3J2RRB54ZR6CYGC'.replace( /^GPL/, 'GPL' ) );
	check( 'a device id is sent', typeof f.calls[ 0 ].body.device === 'string' && f.calls[ 0 ].body.device.length > 8 );
	check( 'the key is remembered', await store.get( 'printlab.licence.key' ) !== '' );
} )() );

run.push( ( async () => {
	const store = memStore();
	const f = fakeFetch( [ { status: 200, body: { valid: false, reason: 'unknown_key' } } ] );
	const r = await licence.check( { store, fetchImpl: f, randomHex, now: '2026-08-30' }, KEY );
	check( 'an unknown key is refused', r.state === 'refused' );
	check( 'and is not kept', await store.get( 'printlab.licence.key' ) === '' );
} )() );

run.push( ( async () => {
	const store = memStore( { 'printlab.licence.key': licence.normalise( KEY ) } );
	const f = fakeFetch( [ { status: 200, body: { valid: false, reason: 'membership_inactive' } } ] );
	const r = await licence.check( { store, fetchImpl: f, randomHex, now: '2026-08-30' } );
	check( 'a lapsed membership stops the plugin', r.state === 'refused' );
	/* This is the one that matters: they will pay again, and having to retype
	   a 20 character key at that point is a support ticket. */
	check( 'but the key is KEPT so it resumes on payment',
		await store.get( 'printlab.licence.key' ) === licence.normalise( KEY ) );
} )() );

run.push( ( async () => {
	const store = memStore( {
		'printlab.licence.key': licence.normalise( KEY ),
		'printlab.licence.lastOk': '2026-08-28',
		'printlab.licence.lastInfo': JSON.stringify( { plan: 'year', expires: '2027-01-01', trial: false } )
	} );
	const r = await licence.check( { store, fetchImpl: fakeFetch( [ 'network' ] ), randomHex, now: '2026-08-30' } );
	check( 'offline 2 days after a good check still works', r.state === 'grace' );
	check( 'and says how long is left', /12 days left/.test( r.message ) );
	check( 'and keeps the plan details', r.info && r.info.plan === 'year' );
} )() );

run.push( ( async () => {
	const store = memStore( {
		'printlab.licence.key': licence.normalise( KEY ),
		'printlab.licence.lastOk': '2026-08-01'
	} );
	const r = await licence.check( { store, fetchImpl: fakeFetch( [ 'network' ] ), randomHex, now: '2026-08-30' } );
	check( 'offline 29 days after a good check does NOT work', r.state === 'offline' );
} )() );

run.push( ( async () => {
	const store = memStore( { 'printlab.licence.key': licence.normalise( KEY ) } );
	const r = await licence.check( { store, fetchImpl: fakeFetch( [ { status: 500, body: {} } ] ), randomHex, now: '2026-08-30' } );
	/* Our own server having a bad afternoon must not read as "you have not
	   paid" - with no previous good check there is nothing to fall back on,
	   but it must still be an offline message, not an accusation. */
	check( 'a 500 from the shop is treated as offline, not as refusal', r.state === 'offline' );
	check( 'and the key survives it', await store.get( 'printlab.licence.key' ) !== '' );
} )() );

run.push( ( async () => {
	const store = memStore();
	const f = fakeFetch( [] );
	const r = await licence.check( { store, fetchImpl: f, randomHex, now: '2026-08-30' }, 'not-a-key' );
	check( 'a malformed key is refused without a network call', r.state === 'refused' && f.calls.length === 0 );
} )() );

/* ------------------------------------------------------------------ */
/* 3. The Photoshop bridge, against a fake Photoshop                   */
/* ------------------------------------------------------------------ */

section( 'guards on the document' );

function fakePS( over ) {
	const doc = Object.assign( {
		id: 7, name: 'art.psd', mode: 'RGBColor', bitsPerChannel: 8,
		width: 1200, height: 900, resolution: 300,
		activeLayers: [ { id: 3, name: 'Layer 1', kind: 'pixel', locked: false } ]
	}, ( over || {} ).doc || {} );

	const calls = [];

	return {
		calls,
		app: { get activeDocument() { return ( over || {} ).noDoc ? null : doc; } },
		core: {
			executeAsModal: ( fn, o ) => {
				calls.push( { modal: o.commandName } );
				return Promise.resolve( fn( {
					hostControl: {
						suspendHistory: ( a ) => { calls.push( { suspend: a.name } ); return Promise.resolve( 99 ); },
						resumeHistory: ( t ) => { calls.push( { resume: t } ); return Promise.resolve(); }
					}
				} ) );
			}
		},
		imaging: {
			getPixels: ( o ) => {
				calls.push( { getPixels: o } );
				const comps = ( over || {} ).components || 4;
				const w = o.targetSize ? o.targetSize.width : doc.width;
				const h = o.targetSize ? o.targetSize.height : doc.height;
				const buf = new Uint8Array( w * h * comps );
				for ( let i = 0; i < buf.length; i++ ) buf[ i ] = ( i * 7 ) % 256;
				return Promise.resolve( {
					imageData: {
						width: w, height: h,
						getData: () => Promise.resolve( buf ),
						dispose: () => calls.push( { dispose: 'read' } )
					}
				} );
			},
			createImageDataFromBuffer: ( buf, o ) => {
				calls.push( { create: o, buf: Uint8Array.from( buf ) } );
				return { dispose: () => calls.push( { dispose: 'write' } ) };
			},
			putPixels: ( o ) => {
				calls.push( { putPixels: { documentID: o.documentID, layerID: o.layerID, replace: o.replace } } );
				return ( over || {} ).putFails ? Promise.reject( new Error( 'put failed' ) ) : Promise.resolve();
			}
		}
	};
}

check( 'no document open is explained', /Open an image/.test( new Bridge( fakePS( { noDoc: true } ) ).blocker() ) );
check( 'a CMYK document is refused', /RGB/.test( new Bridge( fakePS( { doc: { mode: 'CMYKColor' } } ) ).blocker() ) );
check( 'a 16 bit document is refused', /8 bit/.test( new Bridge( fakePS( { doc: { bitsPerChannel: 16 } } ) ).blocker() ) );
check( 'a text layer is refused', /Rasterise/.test( new Bridge( fakePS( { doc: { activeLayers: [ { id: 1, kind: 'text' } ] } } ) ).blocker() ) );
check( 'a locked layer is refused', /locked/.test( new Bridge( fakePS( { doc: { activeLayers: [ { id: 1, kind: 'pixel', locked: true } ] } } ) ).blocker() ) );
check( 'no layer selected is explained', /Select a layer/.test( new Bridge( fakePS( { doc: { activeLayers: [] } } ) ).blocker() ) );
check( 'a normal RGB 8 bit document passes', new Bridge( fakePS() ).blocker() === '' );

section( 'reading and writing pixels' );

run.push( ( async () => {
	const ps = fakePS();
	const b = new Bridge( ps );
	const frame = await b.read( 0 );
	check( 'a full read asks for no target size', ps.calls.some( ( c ) => c.getPixels && ! c.getPixels.targetSize ) );
	check( 'it reads the active layer of the active document',
		ps.calls.some( ( c ) => c.getPixels && c.getPixels.documentID === 7 && c.getPixels.layerID === 3 ) );
	check( 'the buffer is four bytes a pixel', frame.data.length === frame.width * frame.height * 4 );
	check( 'the read image data is disposed', ps.calls.some( ( c ) => c.dispose === 'read' ) );
	check( 'a full read is scale 1', frame.scale === 1 );
} )() );

run.push( ( async () => {
	const ps = fakePS();
	const frame = await new Bridge( ps ).read( 300 );
	check( 'a preview read downscales', frame.width === 300 && frame.height === 225 );
	check( 'and reports the scale it used', Math.abs( frame.scale - 0.25 ) < 1e-9 );
} )() );

run.push( ( async () => {
	/* Photoshop hands back three components when the layer has no alpha. The
	   engine indexes in fours, so this has to be repacked or every pixel after
	   the first is read from the wrong offset. */
	const ps = fakePS( { components: 3 } );
	const frame = await new Bridge( ps ).read( 0 );
	check( 'a 3-component layer is repacked to RGBA', frame.data.length === frame.width * frame.height * 4 );
	check( 'and the alpha is filled in opaque', frame.data[ 3 ] === 255 && frame.data[ 7 ] === 255 );
	check( 'and the colours are not shifted', frame.data[ 0 ] === 0 && frame.data[ 1 ] === 7 && frame.data[ 2 ] === 14 && frame.data[ 4 ] === 21 );
} )() );

run.push( ( async () => {
	const ps = fakePS();
	const b = new Bridge( ps );
	const frame = await b.read( 0 );
	ps.calls.length = 0;
	await b.write( frame, 'Print Lab' );
	check( 'the write is one undo step', ps.calls.some( ( c ) => c.suspend === 'Print Lab' ) );
	check( 'history is resumed', ps.calls.some( ( c ) => c.resume === 99 ) );
	check( 'it writes back to the layer it read', ps.calls.some( ( c ) => c.putPixels && c.putPixels.layerID === 3 && c.putPixels.replace === true ) );
	check( 'the written image data is disposed', ps.calls.some( ( c ) => c.dispose === 'write' ) );
	check( 'it is tagged as 8 bit RGBA chunky sRGB', ps.calls.some( ( c ) => c.create && c.create.components === 4 && c.create.chunky === true && c.create.colorSpace === 'RGB' ) );
} )() );

run.push( ( async () => {
	/* If putPixels throws and history is left suspended, every later edit in
	   that document is unrecordable - a far worse outcome than the failure. */
	const ps = fakePS( { putFails: true } );
	const b = new Bridge( ps );
	const frame = await b.read( 0 );
	ps.calls.length = 0;
	let threw = false;
	try {
		await b.write( frame, 'Print Lab' );
	} catch ( e ) {
		threw = true;
	}
	check( 'a failed write still reports the failure', threw );
	check( 'and still resumes history', ps.calls.some( ( c ) => c.resume === 99 ) );
	check( 'and still disposes the image data', ps.calls.some( ( c ) => c.dispose === 'write' ) );
} )() );

/* ------------------------------------------------------------------ */
/* 4. Apply, end to end, with the real engine                          */
/* ------------------------------------------------------------------ */

section( 'apply' );

run.push( ( async () => {
	const ps = fakePS();
	const bridge = new Bridge( ps );
	const S = Object.assign( studio.defaults(), { halftone: true, lpi: 40 } );
	const stages = [];
	const input = ( await bridge.read( 0 ) ).data;
	ps.calls.length = 0;
	const res = await studio.apply( { bridge, engine }, S, { onStage: ( s ) => stages.push( s ) } );
	check( 'apply completes', !! res && res.width === 1200 );
	check( 'it tells the customer what it is doing', stages.length >= 2 );
	const written = ps.calls.filter( ( c ) => c.putPixels );
	check( 'exactly one write', written.length === 1 );

	/* What was actually handed back to Photoshop - not a length, the bytes. */
	const sent = ps.calls.find( ( c ) => c.buf ).buf;
	check( 'the pixels handed back are not the pixels read',
		! Buffer.from( sent ).equals( Buffer.from( input ) ) );

	/* And they are exactly what the engine alone produces from those inputs,
	   so the plugin is not quietly doing anything of its own on the way. */
	const expected = new Uint8ClampedArray( input );
	engine.run( expected, res.width, res.height, studio.settingsForEngine( studio.clampSettings( S ) ), 1 );
	check( 'and they are exactly what the engine produces',
		Buffer.from( sent ).equals( Buffer.from( expected.buffer ) ) );
} )() );

run.push( ( async () => {
	const bridge = new Bridge( fakePS() );
	const S = Object.assign( studio.defaults(), { halftone: true, underbase: true, choke: 2 } );
	const res = await studio.apply( { bridge, engine }, S, {} );
	check( 'an underbase is produced when asked for', res.underbase === true && !! res.underbaseData );
} )() );

run.push( ( async () => {
	const bridge = new Bridge( fakePS( { doc: { mode: 'CMYKColor' } } ) );
	let msg = '';
	try {
		await studio.apply( { bridge, engine }, studio.defaults(), {} );
	} catch ( e ) {
		msg = e.message;
	}
	check( 'apply refuses a CMYK document before touching pixels', /RGB/.test( msg ) );
} )() );

run.push( ( async () => {
	const bridge = new Bridge( fakePS() );
	let msg = '';
	try {
		await studio.apply( { bridge, engine: { ENGINE_API: 99, run: () => {} } }, studio.defaults(), {} );
	} catch ( e ) {
		msg = e.message;
	}
	check( 'a mismatched engine fails loudly', /different versions/.test( msg ) );
} )() );

/* ------------------------------------------------------------------ */
/* 4b. Preview                                                         */
/* ------------------------------------------------------------------ */

section( 'preview' );

run.push( ( async () => {
	const ps = fakePS();
	const bridge = new Bridge( ps );
	const S = Object.assign( studio.defaults(), {
		halftone: true, lpi: 40, inkEnabled: true, ink: [ 200, 16, 46 ]
	} );

	ps.calls.length = 0;

	const res = await studio.preview( { bridge, engine }, S, {} );

	/* The whole reason preview is separate from apply. Looking at an ink
	   colour must not put a step in anyone's history to undo. */
	check( 'preview never writes to the document',
		ps.calls.filter( ( c ) => c.putPixels ).length === 0 );
	check( 'preview never touches history',
		! ps.calls.some( ( c ) => c.suspend !== undefined || c.resume !== undefined ) );

	check( 'preview returns pixels', !! res.data && res.data.length === res.width * res.height * 4 );

	/* Read small on purpose - the engine runs on the main thread here. */
	check( 'preview reads a proxy, not the full file',
		Math.max( res.width, res.height ) <= studio.PREVIEW_MAX_SIDE );
	check( 'and the full file is bigger than that', 1200 > studio.PREVIEW_MAX_SIDE );

	/* A preview that showed something other than what Apply produces would be
	   worse than no preview. Same input, same settings, same scale -> same
	   bytes as the engine alone. */
	const src = ( await bridge.read( studio.PREVIEW_MAX_SIDE ) );
	const expected = new Uint8ClampedArray( src.data );
	engine.run( expected, src.width, src.height,
		studio.settingsForEngine( studio.clampSettings( S ) ), src.scale );
	check( 'preview shows exactly what apply would produce',
		Buffer.from( res.data.buffer ).equals( Buffer.from( expected.buffer ) ) );

	/* And the ink actually landed, or the check above would pass on two
	   equally wrong pictures. */
	let inked = 0;
	let offInk = 0;
	for ( let i = 0; i < res.data.length; i += 4 ) {
		if ( res.data[ i + 3 ] === 0 ) continue;
		inked++;
		if ( res.data[ i ] !== 200 || res.data[ i + 1 ] !== 16 || res.data[ i + 2 ] !== 46 ) offInk++;
	}
	check( 'the preview is in the chosen ink (' + inked + ' px, ' + offInk + ' wrong)',
		inked > 100 && offInk === 0 );
} )() );

run.push( ( async () => {
	const bridge = new Bridge( fakePS( { doc: { mode: 'CMYKColor' } } ) );
	let msg = '';
	try {
		await studio.preview( { bridge, engine }, studio.defaults(), {} );
	} catch ( e ) {
		msg = e.message;
	}
	check( 'preview refuses a CMYK document too', /RGB/.test( msg ) );
} )() );

run.push( ( async () => {
	const bridge = new Bridge( fakePS() );
	const S = Object.assign( studio.defaults(), { underbase: true, choke: 2, halftone: true } );
	const res = await studio.preview( { bridge, engine }, S, {} );
	check( 'preview builds the underbase so it can be shown underneath',
		res.underbase === true && !! res.underbaseData );
} )() );

section( 'what the customer is told they are on' );

/* A key given away for nothing is not a monthly membership. Telling somebody
   with free lifetime access that they are on a monthly plan "paid to" nothing
   is both wrong and a support call. */
check( 'a lapsed-reason string exists for a revoked key',
	licence.explain( 'key_revoked' ).indexOf( 'switched off' ) !== -1 );
check( 'and for an expired one',
	licence.explain( 'key_expired' ).indexOf( 'run out' ) !== -1 );
check( 'neither leaks the reason code',
	[ 'key_revoked', 'key_expired' ].every( ( r ) => licence.explain( r ).indexOf( '_' ) === -1 ) );

section( 'settings are bounded' );

const wild = studio.clampSettings( Object.assign( studio.defaults(), {
	lpi: 0, dpi: 0, adjGamma: 0, inGamma: -4, choke: 9999, knockout: 'nonsense'
} ) );
check( 'lpi can never be zero (it is a divisor)', wild.lpi >= 5 );
check( 'dpi is brought into range', wild.dpi >= 72 );
check( 'gamma can never be zero', wild.adjGamma > 0 && wild.inGamma > 0 );
check( 'choke is capped', wild.choke <= 20 );
check( 'a broken knockout falls back to black', Array.isArray( wild.knockout ) && wild.knockout.length === 3 );

const inks = studio.clampSettings( Object.assign( studio.defaults(), { ink: 'not a colour' } ) );
check( 'a broken ink falls back to black', JSON.stringify( inks.ink ) === '[0,0,0]' );

const outOfRange = studio.clampSettings( Object.assign( studio.defaults(), { ink: [ 999, -40, 12.6 ] } ) );
check( 'ink channels are brought into range', JSON.stringify( outOfRange.ink ) === '[255,0,13]' );

const shirts = studio.clampSettings( Object.assign( studio.defaults(), { shirt: 'not a colour' } ) );
check( 'a broken garment colour falls back to black', JSON.stringify( shirts.shirt ) === '[0,0,0]' );

const shirtRange = studio.clampSettings( Object.assign( studio.defaults(), { shirt: [ 300, -1, 7.4 ] } ) );
check( 'garment channels are brought into range', JSON.stringify( shirtRange.shirt ) === '[255,0,7]' );

section( 'the garment colour is preview only' );

/* The claim printed on the panel, checked rather than trusted. If shirt ever
   reached the engine this would fail, and the failure would be a customer
   printing a navy rectangle. */
check( 'the garment is not one of the settings the engine is given',
	studio.ENGINE_KEYS.indexOf( 'shirt' ) === -1 &&
	studio.ENGINE_KEYS.indexOf( 'shirtPreview' ) === -1 );

const withShirt = studio.settingsForEngine( studio.clampSettings( Object.assign(
	studio.defaults(), { shirtPreview: true, shirt: [ 27, 42, 68 ] }
) ) );
check( 'and it is absent from what is actually sent',
	! ( 'shirt' in withShirt ) && ! ( 'shirtPreview' in withShirt ) );

const noShirt = studio.settingsForEngine( studio.clampSettings( studio.defaults() ) );
check( 'so the engine is handed the same job with a garment set or not',
	JSON.stringify( withShirt ) === JSON.stringify( noShirt ) );

/* The check above passes because the screen is OFF by default, which is the
   case where the claim is easy - two of the five modes do read the garment
   once it is on. Every mode has to be walked, or a regression that leaked the
   garment into, say, the opacity screen would sit there green. */
[ 'dark', 'white', 'opacity' ].forEach( ( mode ) => {
	const a = studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(), { halftone: true, screenSource: mode, shirt: [ 27, 42, 68 ] }
	) ) );
	const b = studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(), { halftone: true, screenSource: mode, shirt: [ 240, 12, 3 ] }
	) ) );

	check( 'on "' + mode + '" the garment still changes nothing the engine sees',
		JSON.stringify( a ) === JSON.stringify( b ) );
} );

/* And the modes where it MUST change something. A promise only kept because
   the feature is broken is not a promise kept. */
function garmentJob( shirt, extra ) {
	return studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(),
		{ halftone: true, screenSource: 'garment', shirt: shirt },
		extra || {}
	) ) );
}

const navyJob = garmentJob( [ 27, 42, 68 ] );
const whiteJob = garmentJob( [ 255, 255, 255 ] );

check( 'on the garment setting the garment DOES reach the engine',
	JSON.stringify( navyJob.screenGarment ) === '[27,42,68]' );
check( 'and two garments are two different jobs',
	JSON.stringify( navyJob ) !== JSON.stringify( whiteJob ) );
check( 'a dark garment is assumed to be printed in white ink',
	JSON.stringify( navyJob.screenInk ) === '[255,255,255]' );
check( 'a light one in black',
	JSON.stringify( whiteJob.screenInk ) === '[0,0,0]' );
check( 'and a chosen ink beats the assumption',
	JSON.stringify( garmentJob( [ 27, 42, 68 ], {
		inkEnabled: true, ink: [ 255, 210, 0 ]
	} ).screenInk ) === '[255,210,0]' );

/* Halftone off means no screening, so there is nothing to measure against and
   the garment must not be sent even on this mode. */
check( 'with the screen switched off the garment is not sent at all',
	studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(), { halftone: false, screenSource: 'garment', shirt: [ 27, 42, 68 ] }
	) ) ).screenGarment === null );

section( 'the full colour screen' );

/* Why this mode exists: every other one is a ONE INK answer, and a one ink
   answer flattens a colour design. Measured on his neon print on black, the
   green came back at 33% dots and the white next to it at 96%. On the shirt
   that reads as the green having been taken away. */

function colourJob( shirt, extra ) {
	return studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(),
		{ halftone: true, screenSource: 'colour', shirt: shirt },
		extra || {}
	) ) );
}

check( 'full colour is the default screening mode',
	studio.defaults().screenSource === 'colour' );
check( 'and the engine has a branch of that name',
	fs.readFileSync( path.join( ROOT, 'engine.js' ), 'utf8' ).indexOf( "mode === 'colour'" ) !== -1 );
check( 'on the full colour setting the garment reaches the engine',
	JSON.stringify( colourJob( [ 27, 42, 68 ] ).screenGarment ) === '[27,42,68]' );
check( 'and two garments are two different jobs',
	JSON.stringify( colourJob( [ 27, 42, 68 ] ) ) !== JSON.stringify( colourJob( [ 255, 255, 255 ] ) ) );

/* No single ink to aim at - each pixel's ink is that pixel - so it is handed
   no ink at all rather than one it would silently ignore. A stored ink here
   would be a value the engine never reads, which is the shape of bug that
   makes a control look like it does something. */
check( 'no ink is sent, even when one has been chosen',
	colourJob( [ 27, 42, 68 ], { inkEnabled: true, ink: [ 255, 210, 0 ] } ).screenInk === null );
/* The ink is still SENT, because "Print in one ink" repaints the finished
   dots at the last step whatever mode worked out where they fall. What this
   mode ignores is the ink as an input to that working out, which is the check
   above. The two are easy to conflate and the panel copy said the wrong one
   until this test disagreed with it. */
check( 'but the ink still reaches the last step, which repaints the dots',
	JSON.stringify( colourJob( [ 27, 42, 68 ], { inkEnabled: true, ink: [ 255, 210, 0 ] } ).ink ) ===
	'[255,210,0]' );

check( 'with the screen off the garment is not sent on this mode either',
	colourJob( [ 27, 42, 68 ], { halftone: false } ).screenGarment === null );

/* Through the engine, on his own palette. A solid colour must survive as that
   colour, judged by what the screened cell averages to ON THE GARMENT - the
   dot count alone calls a legitimately-94% colour a failure. */
function screened( rgb, shirt, mode ) {
	const s = studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(),
		{ halftone: true, screenSource: mode || 'colour', shirt: shirt,
		  lpi: 30, dpi: 300, microDot: 0, cleanupIntensity: 0 }
	) ) );
	const W = 120, H = 120;
	const d = new Uint8ClampedArray( W * H * 4 );

	for ( let i = 0; i < W * H; i++ ) {
		d[ i * 4 ] = rgb[ 0 ]; d[ i * 4 + 1 ] = rgb[ 1 ];
		d[ i * 4 + 2 ] = rgb[ 2 ]; d[ i * 4 + 3 ] = 255;
	}

	engine.run( d, W, H, s, 1 );

	let n = 0;
	const sum = [ 0, 0, 0 ];
	for ( let i = 0; i < W * H; i++ ) {
		if ( d[ i * 4 + 3 ] > 0 ) {
			n++;
			sum[ 0 ] += d[ i * 4 ]; sum[ 1 ] += d[ i * 4 + 1 ]; sum[ 2 ] += d[ i * 4 + 2 ];
		}
	}

	const seen = [ 0, 1, 2 ].map( ( k ) => ( sum[ k ] + shirt[ k ] * ( W * H - n ) ) / ( W * H ) );
	return {
		pct: 100 * n / ( W * H ),
		err: Math.max( ...[ 0, 1, 2 ].map( ( k ) => Math.abs( seen[ k ] - rgb[ k ] ) ) )
	};
}

const NEON = [ 124, 252, 0 ];
const TEE = [ 0, 0, 0 ];

check( 'his neon green prints as neon green on black',
	screened( NEON, TEE ).err < 4, screened( NEON, TEE ).err );
check( 'and gets as much ink as the white beside it',
	Math.abs( screened( NEON, TEE ).pct - screened( [ 255, 255, 255 ], TEE ).pct ) < 3 );
check( 'which the one-ink mode did not - that is the reported fault',
	screened( [ 255, 255, 255 ], TEE, 'garment' ).pct -
	screened( NEON, TEE, 'garment' ).pct > 35 );
check( 'a shade fading towards the garment still gets dots',
	Math.abs( screened( [ 62, 126, 0 ], TEE ).pct - 50 ) < 6 );
check( 'and that shade averages back to the shade it was',
	screened( [ 62, 126, 0 ], TEE ).err < 4 );
check( 'the garment colour itself lays no ink',
	screened( TEE, TEE ).pct === 0 );
check( 'and neither does sport grey on sport grey',
	screened( [ 170, 170, 170 ], [ 170, 170, 170 ] ).pct === 0 );
check( 'neon green is still neon green on sport grey',
	screened( NEON, [ 170, 170, 170 ] ).err < 4 );

section( 'typing a colour in' );

const BOOK = [
	{ name: 'Heather Sapphire', code: 'GD001-HSA', hex: '#4f7fa8' },
	{ name: 'Heavy Metal', code: 'GD001-HVM', hex: '#5b5f61' },
	{ name: 'Military Green', code: 'GD001-MIG', hex: '#5a5f3c' }
];

const parse = ( s ) => studio.parseColour( s, BOOK );

check( 'a six digit hex', JSON.stringify( parse( '#1b2a44' ).rgb ) === '[27,42,68]' );
check( 'without the hash', JSON.stringify( parse( '1b2a44' ).rgb ) === '[27,42,68]' );
check( 'a three digit hex is expanded', JSON.stringify( parse( '#f0a' ).rgb ) === '[255,0,170]' );
check( 'R,G,B numbers', JSON.stringify( parse( '176, 178, 174' ).rgb ) === '[176,178,174]' );
check( 'out of range channels are brought in', JSON.stringify( parse( '300, -4, 12' ).rgb ) === '[255,0,12]' );
check( 'four numbers are read as CMYK, not as anything else',
	JSON.stringify( parse( '0, 100, 100, 0' ).rgb ) === '[255,0,0]' );
check( 'and are labelled as an approximation',
	parse( 'cmyk(0,100,100,0)' ).label.indexOf( 'approximate' ) !== -1 );
check( 'a name from the book', JSON.stringify( parse( 'Military Green' ).rgb ) === '[90,95,60]' );
check( 'a code from the book', JSON.stringify( parse( 'gd001-mig' ).rgb ) === '[90,95,60]' );
check( 'the label says which one it matched',
	parse( 'gd001-mig' ).label === 'Military Green (GD001-MIG)' );
check( 'a unique start of a name is enough',
	JSON.stringify( parse( 'Military' ).rgb ) === '[90,95,60]' );

/* The two Heather/Heavy entries exist for this one check. A box that picks
   the first of two colours somebody might have meant is worse than one that
   asks, because the wrong garment looks exactly like the right one. */
check( 'a prefix two colours share is refused, not guessed',
	! parse( 'Hea' ).rgb && parse( 'Hea' ).error.indexOf( 'More than one' ) === 0 );
check( 'one more letter and it is no longer a choice',
	JSON.stringify( parse( 'Heav' ).rgb ) === '[91,95,97]' );
check( 'a Pantone reference is refused', ! parse( 'Pantone 19-4052 TCX' ).rgb );
check( 'and says why rather than "not found"',
	parse( 'PMS 288' ).error.toLowerCase().indexOf( 'pantone' ) !== -1 );
check( 'a bare TCX style number is caught too',
	parse( '19-4052' ).error.toLowerCase().indexOf( 'pantone' ) !== -1 );
check( 'nonsense is refused', ! parse( 'qqqq' ).rgb );
check( 'an empty box says nothing rather than complaining',
	! parse( '' ).rgb && parse( '' ).error === '' );

/* The book is data from the shop, so it can contain anything. A row with a
   broken colour must be ignored rather than turned into black. */
check( 'a book row with no usable colour is skipped',
	! studio.parseColour( 'Broken', [ { name: 'Broken', code: '', hex: 'not a colour' } ] ).rgb );

section( 'brightness, contrast and vibrance are curves' );

/*
 * Straight at the engine, one flat swatch at a time. These are the checks the
 * browser test on the website makes, repeated here because the plugin ships
 * its own copy of the engine file and "the site is fine" is not the same
 * claim as "the plugin is fine".
 *
 * Every one of them is about an END of the range. The bug being fixed was a
 * brightness that added a flat number to every channel, and a flat number is
 * indistinguishable from a curve in the middle of the range - it only shows
 * itself at black, at white, and on a colour that is already at full strength.
 */
function tone( rgb, over ) {
	const px = new Uint8ClampedArray( [ rgb[ 0 ], rgb[ 1 ], rgb[ 2 ], 255 ] );
	const s = studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(), { adjEnabled: true }, over
	) ) );
	engine.run( px, 1, 1, s, 1 );
	return [ px[ 0 ], px[ 1 ], px[ 2 ] ];
}

function hslSat( rgb ) {
	const mx = Math.max.apply( null, rgb ) / 255;
	const mn = Math.min.apply( null, rgb ) / 255;
	if ( mx === mn ) { return 0; }
	const l = ( mx + mn ) / 2;
	return l > 0.5 ? ( mx - mn ) / ( 2 - mx - mn ) : ( mx - mn ) / ( mx + mn );
}

const BLACK = [ 0, 0, 0 ];
const WHITE = [ 255, 255, 255 ];
const GREEN = [ 0, 255, 0 ];
const GREY = [ 128, 128, 128 ];

[ -100, -40, 40, 100 ].forEach( ( b ) => {
	check( 'brightness ' + b + ' leaves black at black',
		Math.max.apply( null, tone( BLACK, { brightness: b } ) ) === 0 );
	check( 'brightness ' + b + ' leaves white at white',
		Math.min.apply( null, tone( WHITE, { brightness: b } ) ) === 255 );
} );

const litGreen = tone( GREEN, { brightness: 40 } );
check( 'a pure green brightens as a green rather than towards white',
	litGreen[ 0 ] === 0 && litGreen[ 2 ] === 0 && litGreen[ 1 ] === 255 );
check( 'brightness still actually does something to a midtone',
	tone( GREY, { brightness: 40 } )[ 0 ] > 150 );
check( 'and in the other direction',
	tone( GREY, { brightness: -40 } )[ 0 ] < 105 );

[ -100, 100 ].forEach( ( c ) => {
	check( 'contrast ' + c + ' does not clip black',
		Math.max.apply( null, tone( BLACK, { contrast: c } ) ) === 0 );
	check( 'contrast ' + c + ' does not clip white',
		Math.min.apply( null, tone( WHITE, { contrast: c } ) ) === 255 );
} );
check( 'contrast pivots on mid grey',
	Math.abs( tone( GREY, { contrast: 100 } )[ 0 ] - 128 ) <= 1 );

const muted = [ 105, 120, 150 ];
const vivid = [ 60, 105, 210 ];
const gainMuted = hslSat( tone( muted, { vibrance: 100 } ) ) - hslSat( muted );
const gainVivid = hslSat( tone( vivid, { vibrance: 100 } ) ) - hslSat( vivid );

check( 'vibrance lifts a muted colour', gainMuted > 0.15 );
check( 'and lifts an already-vivid one at the same hue far less',
	gainVivid * 4 < gainMuted );
check( 'vibrance leaves grey exactly alone',
	JSON.stringify( tone( GREY, { vibrance: 100 } ) ) === JSON.stringify( GREY ) );
check( 'vibrance cannot push a full-strength colour past full',
	JSON.stringify( tone( GREEN, { vibrance: 100 } ) ) === JSON.stringify( GREEN ) );
check( 'negative vibrance drains the muted colour',
	hslSat( tone( muted, { vibrance: -100 } ) ) < hslSat( muted ) / 2 );
check( 'negative vibrance still leaves grey alone',
	JSON.stringify( tone( GREY, { vibrance: -100 } ) ) === JSON.stringify( GREY ) );

/* Nothing in the adjustments panel may run while the panel is switched off.
   It is one checkbox away from every setting above and worth one check. */
check( 'none of it runs with adjustments disabled',
	JSON.stringify( tone( muted, { adjEnabled: false, brightness: 100, contrast: 100, vibrance: 100 } ) )
		=== JSON.stringify( muted ) );

/* ------------------------------------------------------------------ */

section( 'one colour taken out of the six families' );

/*
 * The reported fault: "green is picking it up as yellow". His Lime Green is
 * C54 M0 Y100 K0, which lands at hue 92 - closer to the green centre at 120
 * than to the yellow one at 60, but only just, so the Yellows slider ends up
 * with 46 per cent of the say over it.
 *
 * The three checks that matter are the fault reproducing, the fix being EXACT
 * rather than nearly, and a colour 22 degrees away staying put. Exactness is
 * not fussiness here: the engine indexes its table at a whole degree, so a
 * pick that rounded differently would leave a sliver of the six families still
 * reaching the very colour that was picked to escape them.
 */
const LIME = [ 117, 255, 0 ];    // JC001 Lime Green, hue 92
const KELLY = [ 23, 255, 0 ];    // JC001 Kelly Green, hue 114
const SUN = [ 255, 232, 0 ];     // JC001 Sun Yellow, hue 54

const limeBug = tone( LIME, { lightYellow: 60 } );
check( 'the Yellows slider moves his lime green while nothing is picked',
	JSON.stringify( limeBug ) !== JSON.stringify( LIME ) );

const limeFixed = tone( LIME, { lightYellow: 60, bandPick: 92 } );
check( 'and leaves it exactly alone once it is picked',
	JSON.stringify( limeFixed ) === JSON.stringify( LIME ), JSON.stringify( limeFixed ) );

check( 'pure yellow still moves by exactly as much as it did',
	JSON.stringify( tone( SUN, { lightYellow: 60, bandPick: 92 } ) )
		=== JSON.stringify( tone( SUN, { lightYellow: 60 } ) ) );

check( 'the picked slider lightens the picked colour',
	tone( LIME, { bandPick: 92, lightPick: 60 } )[ 0 ] > LIME[ 0 ] + 20 );

check( 'and darkens it going the other way',
	tone( LIME, { bandPick: 92, lightPick: -60 } )[ 1 ] < LIME[ 1 ] - 20 );

check( 'kelly green, 22 degrees off, is outside the default window',
	JSON.stringify( tone( KELLY, { bandPick: 92, lightPick: 60 } ) ) === JSON.stringify( KELLY ) );

check( 'and inside it once the window is widened',
	JSON.stringify( tone( KELLY, { bandPick: 92, lightPick: 60, bandPickWidth: 40 } ) )
		!== JSON.stringify( KELLY ) );

check( 'a grey cannot be moved by it, having no hue to belong to',
	JSON.stringify( tone( GREY, { bandPick: 92, lightPick: 100 } ) ) === JSON.stringify( GREY ) );

[ -100, -40, 40, 100 ].forEach( ( a ) => {
	check( 'the picked slider is inert with nothing picked, at ' + a,
		JSON.stringify( tone( LIME, { lightPick: a } ) ) === JSON.stringify( LIME ) );
} );

/* A hand-edited preset, or a future bug upstream, must not be able to index
   past the end of a 360 entry table - which in a typed array reads undefined
   and paints the pixel black rather than throwing. */
[ 360, 400, -5, 'green', null, undefined, NaN ].forEach( ( bad ) => {
	check( 'a bandPick of ' + String( bad ) + ' is refused rather than wrapped',
		JSON.stringify( tone( LIME, { bandPick: bad, lightPick: 100 } ) ) === JSON.stringify( LIME ) );
} );

check( 'the window cannot be clamped to nothing',
	studio.clampSettings( Object.assign( studio.defaults(), { bandPickWidth: 0 } ) ).bandPickWidth >= 5 );

check( 'nor opened wider than the panel allows',
	studio.clampSettings( Object.assign( studio.defaults(), { bandPickWidth: 999 } ) ).bandPickWidth <= 60 );

check( 'a fractional pick is floored, the way the engine looks it up',
	studio.clampSettings( Object.assign( studio.defaults(), { bandPick: 92.9 } ) ).bandPick === 92 );

section( 'cleaning the edge colour' );

/* A preset written before this setting existed has no key for it. Coming back
   as `false` would silently reintroduce the halo on every old job, with nothing
   on the panel to explain why the same file now prints differently. */
const oldPreset = studio.defaults();
delete oldPreset.bgDefringe;
check( 'a preset saved before this existed comes back with it ON',
	studio.clampSettings( oldPreset ).bgDefringe === true );

check( 'an explicit off is respected',
	studio.clampSettings( Object.assign( studio.defaults(), { bgDefringe: false } ) ).bgDefringe === false );

check( 'and it is a real boolean, not a string, by the time the engine sees it',
	studio.clampSettings( Object.assign( studio.defaults(), { bgDefringe: 'yes' } ) ).bgDefringe === true &&
	studio.clampSettings( Object.assign( studio.defaults(), { bgDefringe: 0 } ) ).bgDefringe === false );

check( 'the engine is actually sent it',
	studio.ENGINE_KEYS.indexOf( 'bgDefringe' ) !== -1 &&
	'bgDefringe' in studio.settingsForEngine( studio.clampSettings( studio.defaults() ) ) );

/* The claim that matters, through the engine rather than the settings: with it
   on, a pixel that is half logo and half white background comes back as the
   logo's colour at half alpha, not as a pale opaque mix. */
( function () {
	const W = 24, H = 24, FG = [ 220, 30, 40 ], BG = [ 255, 255, 255 ];
	const S = studio.settingsForEngine( studio.clampSettings( Object.assign(
		studio.defaults(), { bgRemove: true, knockout: BG, bgTolerance: 12, bgSoftness: 6 }
	) ) );

	/* A square with one deliberately half-covered column down its left edge. */
	function art() {
		const d = new Uint8ClampedArray( W * H * 4 );

		for ( let y = 0; y < H; y++ ) {
			for ( let x = 0; x < W; x++ ) {
				const i = ( y * W + x ) * 4;
				let a = 0;

				if ( y >= 4 && y < 20 ) {
					if ( x === 5 ) { a = 0.5; } else if ( x > 5 && x < 19 ) { a = 1; }
				}

				d[ i ] = Math.round( FG[ 0 ] * a + BG[ 0 ] * ( 1 - a ) );
				d[ i + 1 ] = Math.round( FG[ 1 ] * a + BG[ 1 ] * ( 1 - a ) );
				d[ i + 2 ] = Math.round( FG[ 2 ] * a + BG[ 2 ] * ( 1 - a ) );
				d[ i + 3 ] = 255;
			}
		}

		return d;
	}

	const at = ( ( 12 * W ) + 5 ) * 4;

	const on = art();
	engine.run( on, W, H, Object.assign( {}, S, { bgDefringe: true } ), 1 );

	const off = art();
	engine.run( off, W, H, Object.assign( {}, S, { bgDefringe: false } ), 1 );

	check( 'without it the half covered pixel stays a pale opaque mix',
		off[ at + 3 ] === 255 && off[ at + 1 ] > 130,
		'rgb ' + off[ at ] + ',' + off[ at + 1 ] + ',' + off[ at + 2 ] + ' alpha ' + off[ at + 3 ] );

	check( 'with it the half covered pixel is the ink at half alpha',
		Math.abs( on[ at ] - FG[ 0 ] ) <= 6 && Math.abs( on[ at + 1 ] - FG[ 1 ] ) <= 6 &&
		Math.abs( on[ at + 2 ] - FG[ 2 ] ) <= 6 && Math.abs( on[ at + 3 ] - 128 ) <= 6,
		'rgb ' + on[ at ] + ',' + on[ at + 1 ] + ',' + on[ at + 2 ] + ' alpha ' + on[ at + 3 ] );
} )();

/* ------------------------------------------------------------------ */

Promise.all( run ).then( () => {
	const total = ok + fails.length;

	/* A floor. A test file that stops running looks exactly like one that
	   passes, and this one is full of async blocks that could silently vanish. */
	if ( total < 181 ) {
		fails.push( 'only ' + total + ' checks ran, expected at least 181' );
	}

	console.log( '\n' + ( fails.length ? fails.length + ' FAILED of ' + total : 'ALL ' + ok + ' PASSED' ) );
	fails.forEach( ( f ) => console.log( ' - ' + f ) );
	process.exit( fails.length ? 1 : 0 );
}, ( e ) => {
	console.log( '\nthrew: ' + e.stack );
	process.exit( 1 );
} );

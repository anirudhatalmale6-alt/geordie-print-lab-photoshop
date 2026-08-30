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
   has no upscaler and no shirt preview - but a shared key that DISAGREES is a
   customer getting two different results from the same numbers. */
const shared = studio.ENGINE_KEYS.filter( ( k ) => k in wd );
check( 'the plugin sends the same keys the website does', studio.ENGINE_KEYS.length === wk.length &&
	studio.ENGINE_KEYS.every( ( k ) => wk.indexOf( k ) !== -1 ) );
check( 'every engine key has a web default', shared.length === studio.ENGINE_KEYS.length );

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

/* ------------------------------------------------------------------ */

Promise.all( run ).then( () => {
	const total = ok + fails.length;

	/* A floor. A test file that stops running looks exactly like one that
	   passes, and this one is full of async blocks that could silently vanish. */
	if ( total < 68 ) {
		fails.push( 'only ' + total + ' checks ran, expected at least 68' );
	}

	console.log( '\n' + ( fails.length ? fails.length + ' FAILED of ' + total : 'ALL ' + ok + ' PASSED' ) );
	fails.forEach( ( f ) => console.log( ' - ' + f ) );
	process.exit( fails.length ? 1 : 0 );
}, ( e ) => {
	console.log( '\nthrew: ' + e.stack );
	process.exit( 1 );
} );

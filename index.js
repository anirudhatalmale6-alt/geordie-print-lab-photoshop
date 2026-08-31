/**
 * Panel wiring.
 *
 * Everything with any judgement in it lives in studio.js, licence.js and
 * bridge.js, which are testable without Photoshop. This file is the part that
 * cannot be: it moves values between the DOM and those modules.
 */

'use strict';

const photoshop = require( 'photoshop' );
const uxp = require( 'uxp' );

const engine = require( './engine.js' );
const studio = require( './studio.js' );
const licence = require( './licence.js' );
const { Bridge } = require( './bridge.js' );

const bridge = new Bridge( photoshop );

/* secureStorage is where a credential belongs. Some hosts do not have it, so
   fall back to localStorage rather than refusing to start - the key is not a
   secret worth locking the customer out over. */
function backing() {
	try {
		if ( uxp.storage && uxp.storage.secureStorage ) {
			return uxp.storage.secureStorage;
		}
	} catch ( e ) {
		/* fall through */
	}

	return localStorage;
}

const store = licence.makeStore( backing() );

function randomHex( n ) {
	const b = new Uint8Array( n );
	crypto.getRandomValues( b );
	return Array.from( b ).map( ( x ) => x.toString( 16 ).padStart( 2, '0' ) ).join( '' );
}

const deps = { store, fetchImpl: fetch, randomHex };

let S = studio.defaults();
let busy = false;

const $ = ( id ) => document.getElementById( id );

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

function controls() {
	return Array.from( document.querySelectorAll( '[data-k]' ) );
}

function hexFields() {
	return Array.from( document.querySelectorAll( '[data-hex]' ) );
}

/* Colours are held as [r,g,b] because that is what the engine reads. The
   panel shows them as hex because that is what a printer is given. */
function toHex( rgb ) {
	return '#' + rgb.map( ( v ) => (
		'0' + Math.max( 0, Math.min( 255, v | 0 ) ).toString( 16 )
	).slice( -2 ) ).join( '' );
}

function fromHex( s ) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec( String( s ).trim() );

	if ( ! m ) {
		return null;
	}

	const n = parseInt( m[ 1 ], 16 );

	return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];
}

function toScreen() {
	controls().forEach( ( el ) => {
		const k = el.getAttribute( 'data-k' );

		if ( 'checkbox' === el.type ) {
			el.checked = !! S[ k ];
		} else {
			el.value = S[ k ];
		}

		const out = document.querySelector( '[data-o="' + k + '"]' );

		if ( out ) {
			out.textContent = readout( k, S[ k ] );
		}
	} );

	hexFields().forEach( ( el ) => {
		el.value = toHex( S[ el.getAttribute( 'data-hex' ) ] );
	} );

	paintPickChip();
}

function fromScreen( el ) {
	const k = el.getAttribute( 'data-k' );

	if ( 'checkbox' === el.type ) {
		S[ k ] = el.checked;
	} else if ( 'number' === el.type || 'range' === el.type ) {
		S[ k ] = Number( el.value );
	} else {
		S[ k ] = el.value;
	}

	const out = document.querySelector( '[data-o="' + k + '"]' );

	if ( out ) {
		out.textContent = readout( k, S[ k ] );
	}

	paintPickChip();
}

/**
 * What a slider's number should say when the number on its own is not the
 * answer.
 *
 * The picked hue runs from -1 to 359 and -1 means "nothing picked". Printed
 * raw that reads as a setting of minus one degree, which is a colour, and the
 * two sliders under it would then look broken rather than switched off.
 */
function readout( k, v ) {
	if ( 'bandPick' === k ) {
		return v < 0 ? 'off' : v + '°';
	}

	if ( 'bandPickWidth' === k ) {
		return '±' + v + '°';
	}

	return String( v );
}

/**
 * Show the picked hue as the colour it is, and grey out the two sliders that
 * have nothing to act on while it is off.
 */
function paintPickChip() {
	const chip = document.getElementById( 'pick-chip' );

	if ( ! chip ) {
		return;
	}

	const on = S.bandPick >= 0;

	chip.style.background = on ? hueHex( S.bandPick ) : 'transparent';
	chip.style.borderStyle = on ? 'solid' : 'dashed';

	[ 'lightPick', 'bandPickWidth' ].forEach( ( k ) => {
		const el = document.querySelector( '[data-k="' + k + '"]' );

		if ( el ) {
			el.disabled = ! on;
		}
	} );
}

/**
 * A hue angle as a full-strength colour, for the chip beside the slider.
 */
function hueHex( deg ) {
	const x = Math.round( ( 1 - Math.abs( ( ( deg / 60 ) % 2 ) - 1 ) ) * 255 );
	const c = deg < 60 ? [ 255, x, 0 ] :
		deg < 120 ? [ x, 255, 0 ] :
		deg < 180 ? [ 0, 255, x ] :
		deg < 240 ? [ 0, x, 255 ] :
		deg < 300 ? [ x, 0, 255 ] : [ 255, 0, x ];

	return toHex( c );
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function show( which ) {
	$( 'gate' ).classList.toggle( 'hidden', 'gate' !== which );
	$( 'tool' ).classList.toggle( 'hidden', 'tool' !== which );
}

function say( el, text, kind ) {
	const node = $( el );
	node.textContent = text || '';
	node.className = 'msg' + ( kind ? ' ' + kind : '' );
}

/**
 * The same thing for the small explanatory lines under a control.
 *
 * Separate from say() rather than a flag on it, because say() deliberately
 * resets the class list to exactly 'msg' and the three lines that use this one
 * have to stay small - a status sentence that grew to body size every time it
 * changed would shove the controls under it around as you worked.
 */
function note( el, text, kind ) {
	const node = $( el );

	if ( ! node ) {
		return;
	}

	node.textContent = text || '';
	node.className = 'msg small ' + ( kind || 'dim' );
}

function describeDoc() {
	const blocked = bridge.blocker();

	if ( blocked ) {
		$( 'doc' ).textContent = blocked;
		$( 'doc' ).className = 'small warn';
		return;
	}

	const info = bridge.docInfo();
	$( 'doc' ).textContent = info.name + ' - ' + info.width + ' x ' + info.height +
		' at ' + Math.round( info.resolution ) + ' dpi, on ' + info.layerName;
	$( 'doc' ).className = 'dim small';
}

/* What the shop last told us: the garment colour book, and how many AI
   upscales this key has left. Both arrive on the licence check, which happens
   at start-up and again on every Apply, so neither can go stale mid-job. */
let book = [];
let aiLeft = null;

function enterTool( info ) {
	show( 'tool' );
	toScreen();
	describeDoc();

	if ( info ) {
		$( 'plan' ).textContent = planLine( info );

		if ( Array.isArray( info.garments ) ) {
			book = info.garments;
			buildBook();
		}

		if ( info.upscales && typeof info.upscales.left === 'number' ) {
			aiLeft = info.upscales.left;
		}
	}

	aiRefresh();
	screenNote();
}

/* What the customer is actually on. Written out in full rather than assuming
   everyone is a paying member - a key given away for nothing is not a monthly
   membership, and saying so would be both wrong and slightly insulting. */
function planLine( info ) {
	if ( info.trial ) {
		return 'Free trial, ends ' + ( info.expires || 'soon' );
	}

	if ( 'lifetime' === info.plan ) {
		return 'Lifetime access';
	}

	if ( 'free' === info.plan ) {
		return 'Free access' + ( info.expires ? ', until ' + info.expires : '' );
	}

	return ( 'year' === info.plan ? 'Yearly' : 'Monthly' ) + ' membership' +
		( info.expires ? ', paid to ' + info.expires : '' );
}

/* ------------------------------------------------------------------ */
/* Start up                                                            */
/* ------------------------------------------------------------------ */

function start( typed ) {
	say( 'gate-msg', 'Checking…' );

	return licence.check( deps, typed ).then( ( r ) => {
		if ( 'ok' === r.state || 'grace' === r.state ) {
			enterTool( r.info );

			if ( 'grace' === r.state ) {
				say( 'status', r.message, 'warn' );
			}

			return;
		}

		show( 'gate' );
		say( 'gate-msg', r.message, 'no-key' === r.state ? '' : 'warn' );
	} );
}

$( 'unlock' ).addEventListener( 'click', () => {
	const typed = $( 'key' ).value.trim();

	if ( ! typed ) {
		say( 'gate-msg', 'Paste your key first.', 'warn' );
		return;
	}

	start( typed );
} );

$( 'key' ).addEventListener( 'keydown', ( e ) => {
	if ( 'Enter' === e.key ) {
		$( 'unlock' ).click();
	}
} );

$( 'signout' ).addEventListener( 'click', () => {
	licence.signOut( store ).then( () => {
		$( 'key' ).value = '';
		show( 'gate' );
		say( 'gate-msg', 'Signed out.' );
	} );
} );

$( 'reset' ).addEventListener( 'click', () => {
	S = studio.defaults();
	toScreen();
	markSwatches();
	markGarments();
	screenNote();
	repaint();
	say( 'status', 'Back to the defaults.' );
} );

$( 'code-use' ).addEventListener( 'click', useCode );

$( 'code-in' ).addEventListener( 'keydown', ( e ) => {
	if ( 'Enter' === e.key ) {
		e.preventDefault();
		useCode();
	}
} );

document.addEventListener( 'change', ( e ) => {
	if ( e.target && e.target.getAttribute && e.target.getAttribute( 'data-k' ) ) {
		fromScreen( e.target );
	}
} );

document.addEventListener( 'input', ( e ) => {
	if ( e.target && e.target.getAttribute && e.target.getAttribute( 'data-k' ) ) {
		fromScreen( e.target );
	}
} );

/* A half-typed hex is not a colour. Rejecting it and putting the old value
   back is better than accepting a partial one, which would silently print a
   colour nobody chose. */
document.addEventListener( 'change', ( e ) => {
	const el = e.target;

	if ( ! el || ! el.getAttribute || ! el.getAttribute( 'data-hex' ) ) {
		return;
	}

	const k = el.getAttribute( 'data-hex' );
	const rgb = fromHex( el.value );

	if ( ! rgb ) {
		el.value = toHex( S[ k ] );
		return;
	}

	/* The garment is drawn behind the artwork, so in every mode but one a new
	   colour only needs the picture drawn again - not the engine run again.
	   Re-running would take seconds on the main thread to produce identical
	   pixels. setGarment() is where that "but one" is handled. */
	if ( 'shirt' === k ) {
		setGarment( rgb );
		return;
	}

	S[ k ] = rgb;
	el.value = toHex( rgb );
	markSwatches();
	markGarments();
	screenNote();
} );

/* The screening mode and the ink both decide what the note above says, and the
   mode decides whether the garment is an input to the engine at all. */
document.addEventListener( 'change', ( e ) => {
	const k = e.target && e.target.getAttribute && e.target.getAttribute( 'data-k' );

	if ( 'screenSource' === k || 'inkEnabled' === k || 'halftone' === k ) {
		screenNote();
	}
} );

/* The garment switch is the one control whose effect is entirely in the
   preview, so it repaints on the spot instead of waiting for the next run. */
document.addEventListener( 'change', ( e ) => {
	if ( e.target && e.target.getAttribute &&
		'shirtPreview' === e.target.getAttribute( 'data-k' ) ) {
		markGarments();
		repaint();
	}
} );

/* ------------------------------------------------------------------ */
/* Which colours the screen is worked out from                         */
/* ------------------------------------------------------------------ */

/* Does the garment colour reach the engine as things stand? True in exactly
   one mode, and it changes what a garment change has to do - see below. */
function garmentIsPrinted() {
	return 'garment' === S.screenSource && S.halftone;
}

/**
 * Say out loud which two colours the dots are being worked out from.
 *
 * Without this the mode is guesswork: the garment colour is one section up,
 * the ink colour may never have been set, and the dots would move for reasons
 * that are nowhere near where you are looking.
 */
function screenNote() {
	const el = $( 'screen-msg' );

	if ( ! el ) {
		return;
	}

	if ( 'garment' !== S.screenSource ) {
		note( 'screen-msg', '' );
		return;
	}

	const ink = S.inkEnabled ? S.ink : studio.autoInk( S.shirt );
	const close = [ 0, 1, 2 ].every( ( i ) => Math.abs( S.shirt[ i ] - ink[ i ] ) < 12 );

	if ( close ) {
		note( 'screen-msg',
			'The ink and the garment are the same colour, so there is no print to screen. Change one of them.',
			'warn' );
		return;
	}

	note( 'screen-msg', 'Dots worked out from the garment ' + toHex( S.shirt ) + ' and the ink ' +
		toHex( ink ) + ( S.inkEnabled ? '' : ' (assumed - turn "Print in one ink" on to choose)' ) + '.' );
}

/* ------------------------------------------------------------------ */
/* Typing a colour in                                                  */
/* ------------------------------------------------------------------ */

/* The sixteen built-in blanks are offered under their names alongside whatever
   the shop has loaded, so the box answers for both. */
function fullBook() {
	return book.concat( GARMENTS.map( ( g ) => (
		{ name: g.name, code: '', hex: g.hex }
	) ) );
}

function buildBook() {
	const list = $( 'colour-book' );

	if ( ! list ) {
		return;
	}

	list.textContent = '';

	fullBook().forEach( ( e ) => {
		const o = document.createElement( 'option' );

		o.value = e.code || e.name;
		list.appendChild( o );
	} );
}

function useCode() {
	const got = studio.parseColour( $( 'code-in' ).value, fullBook() );

	if ( ! got.rgb ) {
		note( 'code-msg', got.error, 'warn' );
		return;
	}

	setGarment( got.rgb );
	note( 'code-msg', 'Matched ' + got.label + ' - ' + toHex( got.rgb ) + '.' );
}

/**
 * One way in for every way of choosing a garment - swatch, hex box, code box.
 *
 * The important part is the last branch. In the garment screening mode the
 * colour is an input to the engine, so the cached preview is now a picture of
 * a different job. Repainting it under a new backdrop would show a separation
 * that was never worked out for this garment, which is worse than showing
 * nothing: it looks finished.
 */
function setGarment( rgb ) {
	S.shirt = rgb;
	$( 'shirt-hex' ).value = toHex( rgb );

	S.shirtPreview = true;
	document.querySelector( '[data-k="shirtPreview"]' ).checked = true;

	markGarments();
	screenNote();

	if ( garmentIsPrinted() ) {
		lastPreview = null;
		say( 'pv-msg', 'Garment changed - press Preview again. On this setting the dots are worked out from it.', 'warn' );
		return;
	}

	repaint();
}

/* ------------------------------------------------------------------ */
/* Ink swatches                                                        */
/* ------------------------------------------------------------------ */

/* Stock plastisol colours, so the common case is one press rather than
   typing a hex. Any other colour still goes in the box by hand. */
const INKS = [
	{ name: 'Black', hex: '#000000' },
	{ name: 'White', hex: '#ffffff' },
	{ name: 'Red', hex: '#c8102e' },
	{ name: 'Royal blue', hex: '#1d4f91' },
	{ name: 'Navy', hex: '#101820' },
	{ name: 'Green', hex: '#007a33' },
	{ name: 'Yellow', hex: '#ffd100' },
	{ name: 'Orange', hex: '#ff6900' }
];

function markSwatches() {
	const now = toHex( S.ink ).toLowerCase();

	Array.from( document.querySelectorAll( '#swatches button' ) ).forEach( ( b ) => {
		const on = b.getAttribute( 'data-ink' ) === now;
		b.className = on ? 'swatch is-on' : 'swatch';
		b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
	} );
}

function buildSwatches() {
	const wrap = $( 'swatches' );

	INKS.forEach( ( ink ) => {
		const b = document.createElement( 'button' );

		b.type = 'button';
		b.className = 'swatch';
		b.title = ink.name;
		b.setAttribute( 'aria-label', ink.name );
		b.setAttribute( 'data-ink', ink.hex );
		b.style.backgroundColor = ink.hex;

		b.addEventListener( 'click', () => {
			S.ink = fromHex( ink.hex );
			$( 'ink-hex' ).value = ink.hex;
			markSwatches();
			screenNote();
		} );

		wrap.appendChild( b );
	} );

	markSwatches();
}

/* ------------------------------------------------------------------ */
/* Garment colours                                                     */
/* ------------------------------------------------------------------ */

/* Stock blank-garment colours. Same list and same values as the website, so a
   job set up in one and finished in the other looks the same. */
const GARMENTS = [
	{ name: 'White', hex: '#ffffff' },
	{ name: 'Natural', hex: '#e8dfc8' },
	{ name: 'Ash', hex: '#d2d3d0' },
	{ name: 'Sport grey', hex: '#b0b2ae' },
	{ name: 'Charcoal', hex: '#4a4e53' },
	{ name: 'Black', hex: '#101010' },
	{ name: 'Navy', hex: '#1b2a44' },
	{ name: 'Royal', hex: '#1d4f91' },
	{ name: 'Sky', hex: '#84b6dd' },
	{ name: 'Bottle green', hex: '#1c4b3c' },
	{ name: 'Red', hex: '#b5202e' },
	{ name: 'Maroon', hex: '#6a2431' },
	{ name: 'Purple', hex: '#4b2e83' },
	{ name: 'Pink', hex: '#f0a7bf' },
	{ name: 'Yellow', hex: '#f2cf3f' },
	{ name: 'Orange', hex: '#e35205' }
];

function markGarments() {
	const now = toHex( S.shirt ).toLowerCase();

	Array.from( document.querySelectorAll( '#garments button' ) ).forEach( ( b ) => {
		const on = S.shirtPreview && b.getAttribute( 'data-g' ) === now;

		b.className = on ? 'swatch is-on' : 'swatch';
		b.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
	} );
}

function buildGarments() {
	const wrap = $( 'garments' );

	GARMENTS.forEach( ( g ) => {
		const b = document.createElement( 'button' );

		b.type = 'button';
		b.className = 'swatch';
		b.title = g.name;
		b.setAttribute( 'aria-label', 'Preview on a ' + g.name.toLowerCase() + ' garment' );
		b.setAttribute( 'data-g', g.hex );
		b.style.backgroundColor = g.hex;

		/* setGarment switches the preview on as well. Setting the colour
		   without it would look like the button did nothing, which is the whole
		   reason this row is here rather than just the hex box. */
		b.addEventListener( 'click', () => {
			setGarment( fromHex( g.hex ) );
		} );

		wrap.appendChild( b );
	} );

	markGarments();
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/* The last thing Preview produced, kept so the garment colour can be changed
   without running the engine again. */
let lastPreview = null;

/* Drawn behind the artwork so transparency is visible as transparency.
   Without it, white ink on the panel's own background is white on grey and
   looks like nothing happened. */
function drawBackdrop( ctx, w, h ) {
	if ( S.shirtPreview ) {
		ctx.fillStyle = toHex( S.shirt );
		ctx.fillRect( 0, 0, w, h );
		return;
	}

	const step = 8;

	ctx.fillStyle = '#6a6d73';
	ctx.fillRect( 0, 0, w, h );
	ctx.fillStyle = '#575a5f';

	for ( let y = 0; y < h; y += step ) {
		for ( let x = 0; x < w; x += step ) {
			if ( ( ( x / step ) + ( y / step ) ) % 2 === 0 ) {
				ctx.fillRect( x, y, step, step );
			}
		}
	}
}

function layer( data, w, h ) {
	const c = document.createElement( 'canvas' );

	c.width = w;
	c.height = h;

	const cx = c.getContext( '2d' );
	const img = cx.createImageData( w, h );

	img.data.set( data );
	cx.putImageData( img, 0, 0 );

	return c;
}

/* How much of the result you can see through. Nothing transparent means the
   artwork is covering the garment completely - correct, and indistinguishable
   from a broken button unless it is said out loud. */
function countClear( data ) {
	let n = 0;

	for ( let i = 3; i < data.length; i += 4 ) {
		if ( 0 === data[ i ] ) {
			n++;
		}
	}

	return n;
}

function garmentNote() {
	const note = $( 'garment-note' );
	const hide = ! S.shirtPreview || ! lastPreview || lastPreview.clear > 0;

	note.classList.toggle( 'hidden', hide );
}

/* Draw the last preview again with whatever the garment is now. Cheap on
   purpose: no engine, no document read. */
function repaint() {
	garmentNote();

	if ( lastPreview ) {
		paintPreview( lastPreview );
	}
}

function paintPreview( r ) {
	const cv = $( 'pv' );
	const ctx = cv.getContext ? cv.getContext( '2d' ) : null;

	if ( ! ctx ) {
		say( 'pv-msg', 'This version of Photoshop cannot draw the preview. Apply still works.', 'warn' );
		return;
	}

	drawBackdrop( ctx, cv.width, cv.height );

	/* Fit inside the box without cropping or stretching - a preview that
	   changed the proportions would misrepresent the dot spacing. */
	const k = Math.min( cv.width / r.width, cv.height / r.height );
	const dw = Math.max( 1, Math.round( r.width * k ) );
	const dh = Math.max( 1, Math.round( r.height * k ) );
	const dx = Math.round( ( cv.width - dw ) / 2 );
	const dy = Math.round( ( cv.height - dh ) / 2 );

	/* Underbase first, then the colour on top - the order the press lays
	   them down. */
	if ( r.underbase && r.underbaseData ) {
		ctx.drawImage( layer( r.underbaseData, r.width, r.height ), dx, dy, dw, dh );
	}

	ctx.drawImage( layer( r.data, r.width, r.height ), dx, dy, dw, dh );
}

$( 'preview' ).addEventListener( 'click', () => {
	if ( busy ) {
		return;
	}

	busy = true;
	$( 'preview' ).disabled = true;

	/* Checked here for the same reason it is checked on Apply: a preview at
	   900px is a usable result, so leaving it ungated would leave a way to
	   keep using the tool after cancelling. */
	licence.check( deps )
		.then( ( r ) => {
			if ( 'ok' !== r.state && 'grace' !== r.state ) {
				show( 'gate' );
				say( 'gate-msg', r.message, 'warn' );
				throw new Error( '' );
			}

			return studio.preview( { bridge, engine }, S, {
				onStage: ( s ) => say( 'pv-msg', s + '…' )
			} );
		} )
		.then( ( r ) => {
			r.clear = countClear( r.data );
			lastPreview = r;

			garmentNote();
			paintPreview( r );
			say( 'pv-msg', r.width + ' x ' + r.height + ' preview' +
				( S.inkEnabled ? ' in ' + toHex( S.ink ) : '' ), 'ok' );
		} )
		.catch( ( e ) => {
			if ( e && e.message ) {
				say( 'pv-msg', e.message, 'warn' );
			}
		} )
		.then( () => {
			busy = false;
			$( 'preview' ).disabled = false;
		} );
} );

/* ------------------------------------------------------------------ */
/* AI upscale                                                          */
/* ------------------------------------------------------------------ */

var AI_ENDPOINT = 'https://geordieprintco.co.uk/wp-json/bpt/v1/upscale';

/**
 * The button's state, and optionally the line under it.
 *
 * `quiet` exists because this is called at the end of every attempt, including
 * failed ones. Writing the allowance line there would wipe the reason it just
 * failed a fraction of a second after showing it - the customer would see the
 * button go live again and no explanation at all.
 *
 * @param {boolean} quiet Leave the message alone; set the button only.
 */
function aiRefresh( quiet ) {
	const btn = $( 'ai-go' );

	if ( ! btn ) {
		return;
	}

	btn.disabled = null === aiLeft || aiLeft < 1 || busy;

	/* The count where it can be read even when the line under the button is
	   busy saying something else - which is most of the time something has
	   gone wrong, and is exactly when it matters that this did not move. */
	btn.setAttribute( 'data-left', null === aiLeft ? '' : String( aiLeft ) );

	if ( quiet ) {
		return;
	}

	if ( null === aiLeft ) {
		/* Not "0 left". The shop has not said, which is a different thing and
		   must not read as a refusal. */
		note( 'ai-msg', 'Checking how many you have left…' );
		return;
	}

	note( 'ai-msg', aiLeft + ( 1 === aiLeft ? ' AI upscale' : ' AI upscales' ) +
		' left this month.' + ( aiLeft < 1 ? ' Buy more on your membership page.' : '' ),
		aiLeft < 1 ? 'warn' : '' );
}

/**
 * Pixels to a PNG, and back again.
 *
 * The endpoint takes an image file, not a pixel buffer, and hands one back.
 * A canvas is the only encoder and decoder in a panel, so both directions go
 * through one - and both check the canvas can actually do it rather than
 * assuming, because a missing method here would otherwise surface as a
 * confusing failure three steps later.
 */
function pngFromPixels( data, w, h ) {
	const c = document.createElement( 'canvas' );

	c.width = w;
	c.height = h;

	const ctx = c.getContext ? c.getContext( '2d' ) : null;

	if ( ! ctx || ! c.toDataURL ) {
		throw new Error( 'This version of Photoshop cannot encode a PNG in a panel, so the AI upscale cannot run here.' );
	}

	const img = ctx.createImageData( w, h );

	img.data.set( data );
	ctx.putImageData( img, 0, 0 );

	return c.toDataURL( 'image/png' );
}

function pixelsFromDataUrl( url ) {
	return new Promise( ( resolve, reject ) => {
		const im = new Image();

		im.onload = () => {
			const c = document.createElement( 'canvas' );

			c.width = im.naturalWidth || im.width;
			c.height = im.naturalHeight || im.height;

			const ctx = c.getContext( '2d' );

			ctx.drawImage( im, 0, 0 );

			const d = ctx.getImageData( 0, 0, c.width, c.height );

			resolve( {
				data: new Uint8ClampedArray( d.data ),
				width: c.width,
				height: c.height
			} );
		};

		im.onerror = () => reject( new Error( 'The upscaled image came back damaged.' ) );
		im.src = url;
	} );
}

function base64ToBytes( b64 ) {
	const bin = atob( b64 );
	const out = new Uint8Array( bin.length );

	for ( let i = 0; i < bin.length; i++ ) {
		out[ i ] = bin.charCodeAt( i );
	}

	return out;
}

/**
 * A multipart body, built by hand.
 *
 * FormData would be shorter, and it is the one part of this I cannot try
 * against a real UXP host - so it is not used. A byte array and a
 * Content-Type header are plain fetch, which the licence check already proves
 * works in this panel.
 */
function multipart( fields, file ) {
	const boundary = '----printlab' + Math.random().toString( 16 ).slice( 2 ) + Date.now().toString( 16 );
	const enc = new TextEncoder();
	const parts = [];

	Object.keys( fields ).forEach( ( k ) => {
		parts.push( enc.encode(
			'--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' +
			fields[ k ] + '\r\n'
		) );
	} );

	parts.push( enc.encode(
		'--' + boundary + '\r\nContent-Disposition: form-data; name="' + file.name +
		'"; filename="' + file.filename + '"\r\nContent-Type: image/png\r\n\r\n'
	) );
	parts.push( file.bytes );
	parts.push( enc.encode( '\r\n--' + boundary + '--\r\n' ) );

	let total = 0;
	parts.forEach( ( p ) => { total += p.length; } );

	const body = new Uint8Array( total );
	let at = 0;

	parts.forEach( ( p ) => {
		body.set( p, at );
		at += p.length;
	} );

	return { body: body, type: 'multipart/form-data; boundary=' + boundary };
}

function aiUpscale() {
	if ( busy ) {
		return;
	}

	const blocked = bridge.blocker();

	if ( blocked ) {
		note( 'ai-msg', blocked, 'warn' );
		return;
	}

	const scale = Number( $( 'ai-scale' ).value ) || 4;

	busy = true;
	$( 'ai-go' ).disabled = true;
	note( 'ai-msg', 'Reading the layer…' );

	let key = '';
	let frame = null;

	licence.storedKey( store )
		.then( ( k ) => {
			if ( ! k ) {
				throw new Error( 'Sign in with your key first.' );
			}

			key = k;

			return bridge.read( 0 );
		} )
		.then( ( f ) => {
			frame = f;

			/* The server refuses anything that would come out over 16
			   megapixels, and it is a better refusal than mine because it
			   knows the real limit. But it refuses AFTER the upload, and an
			   upload of a very large layer takes a while to be told no - so
			   the arithmetic is done here too. */
			if ( f.width * f.height * scale * scale > 16000000 ) {
				throw new Error(
					'At ' + scale + 'x this would come out over 16 megapixels, which is bigger than ' +
					'the upscaler will produce. The layer is already ' +
					( Math.round( f.width * f.height / 100000 ) / 10 ) + ' megapixels. Try a smaller scale.'
				);
			}

			note( 'ai-msg', 'Sending it up…' );

			const url = pngFromPixels( f.data, f.width, f.height );
			const bytes = base64ToBytes( url.slice( url.indexOf( ',' ) + 1 ) );
			const part = multipart(
				{ key: key, scale: String( scale ) },
				{ name: 'image', filename: 'layer.png', bytes: bytes }
			);

			note( 'ai-msg', 'Redrawing the detail. This takes a few seconds…' );

			return fetch( AI_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': part.type },
				body: part.body
			} );
		} )
		.then( ( res ) => res.json() )
		.then( ( body ) => {
			if ( ! body || ! body.ok ) {
				/*
				 * The allowance is only spent on a job that ran, so a refusal
				 * must not be reported as one less. The shop sends the real
				 * number back on the success path; here it is left alone.
				 */
				throw new Error( ( body && body.message ) || 'The upscaler could not be reached.' );
			}

			if ( typeof body.left === 'number' ) {
				aiLeft = body.left;
			}

			note( 'ai-msg', 'Writing it back…' );

			return pixelsFromDataUrl( body.image );
		} )
		.then( ( out ) => {
			/* Resize FIRST. Writing bigger pixels into a document that is
			   still the old size would put the artwork in as a crop of its own
			   top left corner. */
			return bridge.resizeDocument( frame.info.documentID, out.width, out.height )
				.then( ( info ) => bridge.write( {
					data: out.data,
					width: out.width,
					height: out.height,
					info: info
				}, 'Print Lab: AI upscale' ) )
				.then( () => out );
		} )
		.then( ( out ) => {
			note( 'ai-msg', 'Done - now ' + out.width + ' x ' + out.height + '. ' +
				aiLeft + ' left this month.', 'ok' );
			describeDoc();

			/* The old preview was of the old pixels at the old size. */
			lastPreview = null;
			say( 'pv-msg', 'Press Preview to see the upscaled layer.' );
		} )
		.catch( ( e ) => {
			note( 'ai-msg', ( e && e.message ) || 'The AI upscale did not run.', 'warn' );
		} )
		.then( () => {
			busy = false;

			/* Quiet: whatever the attempt ended up saying - "Done, 6 left" or
			   the reason it stopped - is the thing worth reading, and it is
			   already on screen. */
			aiRefresh( true );
		} );
}

if ( $( 'ai-go' ) ) {
	$( 'ai-go' ).addEventListener( 'click', aiUpscale );
}

/* ------------------------------------------------------------------ */
/* Apply                                                               */
/* ------------------------------------------------------------------ */

$( 'apply' ).addEventListener( 'click', () => {
	if ( busy ) {
		return;
	}

	busy = true;
	$( 'apply' ).disabled = true;

	/*
	 * The membership is re-checked here, not only at start-up. A panel left
	 * open for a fortnight would otherwise keep working long after somebody
	 * cancelled, and this is the moment the work actually happens.
	 */
	licence.check( deps )
		.then( ( r ) => {
			if ( 'ok' !== r.state && 'grace' !== r.state ) {
				show( 'gate' );
				say( 'gate-msg', r.message, 'warn' );
				throw new Error( '' );
			}

			return studio.apply( { bridge, engine }, S, {
				onStage: ( s ) => say( 'status', s + '…' )
			} );
		} )
		.then( ( res ) => {
			say( 'status', 'Done - ' + res.width + ' x ' + res.height +
				( res.underbase ? ', with an underbase' : '' ), 'ok' );
			describeDoc();
		} )
		.catch( ( e ) => {
			if ( e && e.message ) {
				say( 'status', e.message, 'warn' );
			}
		} )
		.then( () => {
			busy = false;
			$( 'apply' ).disabled = false;
		} );
} );

/* Keep the document line honest as the customer switches files. */
try {
	photoshop.action.addNotificationListener(
		[ 'select', 'open', 'close', 'make', 'delete' ],
		() => {
			if ( ! $( 'tool' ).classList.contains( 'hidden' ) ) {
				describeDoc();
			}
		}
	);
} catch ( e ) {
	/* Not fatal - the line is a convenience, and blocker() is re-run on
	   every Apply regardless. */
}

buildSwatches();
buildGarments();
buildBook();
toScreen();
screenNote();
start();

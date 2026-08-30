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
			out.textContent = S[ k ];
		}
	} );

	hexFields().forEach( ( el ) => {
		el.value = toHex( S[ el.getAttribute( 'data-hex' ) ] );
	} );
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
		out.textContent = S[ k ];
	}
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

function enterTool( info ) {
	show( 'tool' );
	toScreen();
	describeDoc();

	if ( info ) {
		$( 'plan' ).textContent = planLine( info );
	}
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
	repaint();
	say( 'status', 'Back to the defaults.' );
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

	S[ k ] = rgb;
	el.value = toHex( rgb );
	markSwatches();
	markGarments();

	/* The garment is drawn behind the artwork, so a new colour only needs the
	   picture drawn again - not the engine run again. Re-running would take
	   seconds on the main thread to produce identical pixels. */
	if ( 'shirt' === k ) {
		repaint();
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

		b.addEventListener( 'click', () => {
			S.shirt = fromHex( g.hex );
			$( 'shirt-hex' ).value = g.hex;

			/* Setting the colour without switching the preview on would look
			   like the button did nothing, which is the whole reason the row
			   is here rather than just the hex box. */
			S.shirtPreview = true;
			document.querySelector( '[data-k="shirtPreview"]' ).checked = true;

			markGarments();
			repaint();
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
toScreen();
start();

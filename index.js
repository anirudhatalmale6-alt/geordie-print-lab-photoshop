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
		if ( info.trial ) {
			$( 'plan' ).textContent = 'Free trial, ends ' + ( info.expires || 'soon' );
		} else {
			$( 'plan' ).textContent = ( 'year' === info.plan ? 'Yearly' : 'Monthly' ) +
				' membership' + ( info.expires ? ', paid to ' + info.expires : '' );
		}
	}
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

toScreen();
start();

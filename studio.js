/**
 * The tool's own logic: settings, and what happens when Apply is pressed.
 *
 * No Photoshop and no DOM in here - the bridge and the engine are passed in -
 * so the behaviour can be tested without either.
 */

'use strict';

/**
 * The defaults are copied from the web app deliberately, value for value.
 * A customer who sets up a job on the website and then opens the plugin must
 * get the same result, and the fastest way to break that is to let the two
 * lists drift. `settingscheck` in the test folder compares them.
 */
function defaults() {
	return {
		dpi: 300,

		adjEnabled: false,
		adjBlack: 0,
		adjGamma: 1,
		adjWhite: 255,
		brightness: 0,
		contrast: 0,
		hue: 0,
		saturation: 0,
		vibrance: 0,
		lightness: 0,

		/* Photoshop's six colour families. Lightness only - nothing in here
		   can change what colour something is, only how dark it goes. */
		lightRed: 0,
		lightYellow: 0,
		lightGreen: 0,
		lightCyan: 0,
		lightBlue: 0,
		lightMagenta: 0,

		/* One colour taken out of the six families and given its own slider.
		   The six sit 60 degrees apart, so a hue between two of them is shared
		   between two sliders - which is right for orange and wrong for a lime
		   green at hue 92, where the Yellows slider ends up with nearly half
		   the say. -1 is "nothing picked" and the whole thing is inert. */
		bandPick: -1,
		bandPickWidth: 20,
		lightPick: 0,

		knockout: [ 0, 0, 0 ],

		bgRemove: false,
		bgTolerance: 12,
		bgSoftness: 6,
		bgDefringe: true,

		halftone: false,
		lpi: 30,
		angle: 22.5,
		shape: 'round',
		screenSource: 'dark',

		inkEnabled: false,
		ink: [ 0, 0, 0 ],

		/* Preview only in every screening mode but one - see screenColours().
		   Same names and same values as the web app so the two read alike. */
		shirt: [ 0, 0, 0 ],
		shirtPreview: false,

		levelsEnabled: false,
		inBlack: 5,
		inGamma: 1,
		inWhite: 150,
		outBlack: 0,
		outWhite: 255,

		microDot: 1,
		cleanupIntensity: 0,

		underbase: false,
		choke: 1
	};
}

/* The exact keys the engine reads. Sending it anything else is harmless but
   sending it one FEWER is not, so the list is explicit rather than a spread. */
var ENGINE_KEYS = [
	'dpi',
	'adjEnabled', 'adjBlack', 'adjGamma', 'adjWhite',
	'brightness', 'contrast',
	'hue', 'saturation', 'vibrance', 'lightness',
	'lightRed', 'lightYellow', 'lightGreen', 'lightCyan', 'lightBlue', 'lightMagenta',
	'bandPick', 'bandPickWidth', 'lightPick',
	'knockout',
	'bgRemove', 'bgTolerance', 'bgSoftness', 'bgDefringe',
	'halftone', 'lpi', 'angle', 'shape', 'screenSource',
	'screenGarment', 'screenInk',
	'inkEnabled', 'ink',
	'levelsEnabled', 'inBlack', 'inGamma', 'inWhite', 'outBlack', 'outWhite',
	'microDot', 'cleanupIntensity',
	'underbase', 'choke'
];

/*
 * The two keys above that are WORKED OUT rather than stored.
 *
 * Everything else in ENGINE_KEYS is a setting with a default and a control.
 * These two are derived from three other settings every time, which is why
 * they have no entry in defaults() - and why the drift test has to know about
 * them rather than expecting a default that should not exist.
 */
var DERIVED_KEYS = [ 'screenGarment', 'screenInk' ];

function luminance( rgb ) {
	return ( rgb[ 0 ] * 0.299 + rgb[ 1 ] * 0.587 + rgb[ 2 ] * 0.114 ) / 255;
}

/**
 * The ink to assume when nobody has said which one.
 *
 * "Print in one ink" is off by default and turning it on is a decision about
 * the press, so screening must not require it. A separation goes down in one
 * colour either way, and on anything but a white garment that colour is nearly
 * always white.
 */
function autoInk( garment ) {
	return luminance( garment ) > 0.5 ? [ 0, 0, 0 ] : [ 255, 255, 255 ];
}

/**
 * The two colours the garment screening mode measures against.
 *
 * The garment colour is preview only everywhere else and provably never
 * reaches the engine. This one mode is the exception and has to be: there is
 * no way to work out how much ink a pixel needs without knowing what it is
 * going down on to. Returning nulls in every other mode is what keeps that
 * promise true rather than merely usually true.
 *
 * Kept identical to `screenColours()` in the website's dtx.js, and the test
 * folder compares the two rather than trusting this comment.
 */
function screenColours( S ) {
	if ( 'garment' !== S.screenSource || ! S.halftone ) {
		return { garment: null, ink: null };
	}

	var garment = S.shirt.slice();

	return {
		garment: garment,
		ink: S.inkEnabled ? S.ink.slice() : autoInk( garment )
	};
}

function settingsForEngine( S ) {
	var out = {};

	ENGINE_KEYS.forEach( function ( k ) {
		out[ k ] = S[ k ];
	} );

	var colours = screenColours( S );

	out.screenGarment = colours.garment;
	out.screenInk = colours.ink;

	return out;
}

/**
 * Sanity bounds. A slider cannot produce these, but a saved preset from an
 * older version can, and lpi at 0 divides by zero inside the halftone.
 */
function clampSettings( S ) {
	var out = {};
	var k;

	for ( k in S ) {
		if ( Object.prototype.hasOwnProperty.call( S, k ) ) {
			out[ k ] = S[ k ];
		}
	}

	out.dpi = Math.min( 2400, Math.max( 72, Number( out.dpi ) || 300 ) );
	out.lpi = Math.min( 120, Math.max( 5, Number( out.lpi ) || 30 ) );
	out.angle = Number( out.angle ) || 0;
	out.adjGamma = Math.min( 9.99, Math.max( 0.01, Number( out.adjGamma ) || 1 ) );
	out.inGamma = Math.min( 9.99, Math.max( 0.01, Number( out.inGamma ) || 1 ) );
	out.bgTolerance = Math.min( 255, Math.max( 0, Number( out.bgTolerance ) || 0 ) );
	out.bgSoftness = Math.min( 255, Math.max( 0, Number( out.bgSoftness ) || 0 ) );

	/* A tick box, so anything that is not plainly false means on. A preset
	   written before this existed has no key at all, and `undefined` there has
	   to come back as the default rather than as off - a file reopened with the
	   edge cleaning silently switched off would print the halo again with
	   nothing on screen to say why. */
	out.bgDefringe = ( 'undefined' === typeof out.bgDefringe || null === out.bgDefringe ) ?
		true : !! out.bgDefringe;
	out.microDot = Math.min( 10, Math.max( 0, Number( out.microDot ) || 0 ) );
	out.cleanupIntensity = Math.min( 10, Math.max( 0, Number( out.cleanupIntensity ) || 0 ) );
	out.choke = Math.min( 20, Math.max( 0, Number( out.choke ) || 0 ) );

	/* The brightness/contrast pair go into a lookup table and the six colour
	   sliders into a per-hue table. A NaN from a hand-edited preset would
	   propagate through either one and come out as a black pixel rather than
	   as an error, so they are numbers or they are zero. */
	[ 'brightness', 'contrast', 'vibrance', 'lightPick', 'lightRed', 'lightYellow', 'lightGreen',
		'lightCyan', 'lightBlue', 'lightMagenta' ].forEach( function ( key ) {
		out[ key ] = Math.min( 100, Math.max( -100, Number( out[ key ] ) || 0 ) );
	} );

	/* The picked hue indexes a 360-entry table. A NaN or an out-of-range number
	   would read past the end of it, which in a typed array is `undefined` and
	   turns the pixel black rather than throwing - so anything that is not a
	   hue on the wheel becomes -1, which the engine reads as "nothing picked"
	   and ignores entirely. Floored to match how the engine looks it up. */
	out.bandPick = Number( out.bandPick );
	out.bandPick = ( isFinite( out.bandPick ) && out.bandPick >= 0 && out.bandPick < 360 ) ?
		Math.floor( out.bandPick ) : -1;
	out.bandPickWidth = Math.min( 60, Math.max( 5, Number( out.bandPickWidth ) || 20 ) );

	if ( ! Array.isArray( out.knockout ) || 3 !== out.knockout.length ) {
		out.knockout = [ 0, 0, 0 ];
	}

	/* The engine writes ink straight into the pixel buffer, so a malformed
	   value here would paint undefined - which clamps to 0 and silently prints
	   black instead of refusing. Falling back to black is the same colour, but
	   deliberately rather than by accident. */
	if ( ! Array.isArray( out.ink ) || 3 !== out.ink.length ) {
		out.ink = [ 0, 0, 0 ];
	} else {
		out.ink = out.ink.map( function ( v ) {
			return Math.min( 255, Math.max( 0, Math.round( Number( v ) || 0 ) ) );
		} );
	}

	/* The garment never reaches the engine, but it does reach fillStyle, and a
	   colour string canvas cannot parse is ignored silently - leaving the last
	   good colour on screen while the panel claims a different one. Clamped for
	   the same reason as the ink, just a different way of being wrong. */
	if ( ! Array.isArray( out.shirt ) || 3 !== out.shirt.length ) {
		out.shirt = [ 0, 0, 0 ];
	} else {
		out.shirt = out.shirt.map( function ( v ) {
			return Math.min( 255, Math.max( 0, Math.round( Number( v ) || 0 ) ) );
		} );
	}

	return out;
}

/* ------------------------------------------------------------------ */
/* Typing a colour in                                                  */
/* ------------------------------------------------------------------ */

/*
 * Codes that name a colour in a book we do not have. Worth recognising
 * precisely so it can be turned down properly, because the failure that matters
 * here is not "no match" - it is guessing, and sending somebody a garment that
 * is nearly the right navy.
 */
var LICENSED = /pantone|\bpms\b|\btcx\b|\btpg\b|\btpx\b|^\d{2}\s*-\s*\d{4}$/i;

function hexToRgb( s ) {
	var m = /^#?([0-9a-f]{6})$/i.exec( String( s ).trim() );

	if ( ! m ) {
		return null;
	}

	var n = parseInt( m[ 1 ], 16 );

	return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];
}

/**
 * Turn whatever was typed into an RGB triple, or say why not.
 *
 * Returns { rgb, label } on success and { error } otherwise. There is
 * deliberately no "closest match" path: for somebody choosing a garment to
 * print on, a colour that is nearly right is worse than no answer, because a
 * wrong answer looks exactly like a right one.
 *
 * Same rules as the website's box, and the test folder checks a list of inputs
 * against both rather than trusting this sentence.
 *
 * @param {string} raw  What was typed.
 * @param {Array}  book Entries of { name, code, hex }.
 * @return {Object}
 */
function parseColour( raw, book ) {
	var s = String( raw || '' ).trim();

	if ( ! s ) {
		return { error: '' };
	}

	var lower = s.toLowerCase();
	var list = ( book || [] ).filter( function ( e ) {
		return e && e.hex && hexToRgb( e.hex );
	} );
	var i, e, hit;

	/* Names and codes first. A supplier code can be six characters of hex by
	   coincidence, and the book is the more specific answer. */
	for ( i = 0; i < list.length; i++ ) {
		e = list[ i ];

		if ( String( e.name ).toLowerCase() === lower ||
			( e.code && String( e.code ).toLowerCase() === lower ) ) {
			return {
				rgb: hexToRgb( e.hex ),
				label: e.name + ( e.code ? ' (' + e.code + ')' : '' )
			};
		}
	}

	hit = null;

	for ( i = 0; i < list.length; i++ ) {
		e = list[ i ];

		if ( String( e.name ).toLowerCase().indexOf( lower ) === 0 ||
			( e.code && String( e.code ).toLowerCase().indexOf( lower ) === 0 ) ) {
			/* Two colours starting the same way is not a match, it is a choice,
			   and this box must not make it on their behalf. */
			if ( hit && hit.hex !== e.hex ) {
				return { error: 'More than one colour starts with "' + s + '". Type more of the name.' };
			}

			hit = e;
		}
	}

	if ( hit ) {
		return {
			rgb: hexToRgb( hit.hex ),
			label: hit.name + ( hit.code ? ' (' + hit.code + ')' : '' )
		};
	}

	var m = /^#?([0-9a-f]{6})$/i.exec( s );

	if ( m ) {
		return { rgb: hexToRgb( m[ 1 ] ), label: '#' + m[ 1 ].toLowerCase() };
	}

	m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec( s );

	if ( m ) {
		var full = m[ 1 ] + m[ 1 ] + m[ 2 ] + m[ 2 ] + m[ 3 ] + m[ 3 ];

		return { rgb: hexToRgb( full ), label: '#' + full.toLowerCase() };
	}

	var nums = s.match( /-?\d+(?:\.\d+)?/g ) || [];
	var n;

	if ( ( /^\s*cmyk/i.test( s ) || 4 === nums.length ) && 4 === nums.length ) {
		n = nums.map( function ( v ) {
			return Math.max( 0, Math.min( 100, parseFloat( v ) ) ) / 100;
		} );

		/* Plain arithmetic, no colour management. It is right enough to look at
		   and it is labelled as an approximation, because a real CMYK
		   conversion needs the press profile and there is not one here. */
		return {
			rgb: [
				Math.round( 255 * ( 1 - n[ 0 ] ) * ( 1 - n[ 3 ] ) ),
				Math.round( 255 * ( 1 - n[ 1 ] ) * ( 1 - n[ 3 ] ) ),
				Math.round( 255 * ( 1 - n[ 2 ] ) * ( 1 - n[ 3 ] ) )
			],
			label: 'CMYK ' + nums.join( ' / ' ) + ' (approximate)'
		};
	}

	if ( 3 === nums.length ) {
		n = nums.map( function ( v ) {
			return Math.max( 0, Math.min( 255, Math.round( parseFloat( v ) ) ) );
		} );

		return { rgb: n, label: 'RGB ' + n.join( ', ' ) };
	}

	if ( LICENSED.test( s ) ) {
		return {
			error: '"' + s + '" is not in your colour book. Pantone will not let us ship their ' +
				'numbers, and guessing one would give you a garment that is nearly right - so add ' +
				'it to the book once with the colour beside it and it will work from then on.'
		};
	}

	return { error: 'Not recognised. Try a name from the list, a hex code like #1b2a44, R,G,B numbers, or four CMYK percentages.' };
}

/**
 * How big a preview to read. Not a taste - the engine is per-pixel work on the
 * main thread, because UXP has no worker to put it on, so the preview has to
 * be small enough that the panel does not appear to hang.
 */
var PREVIEW_MAX_SIDE = 900;

/**
 * The half that Apply and Preview have in common: check, read, run.
 *
 * Deliberately one function. A preview that ran different code from Apply
 * would be a picture of something else, and the whole value of a preview is
 * that it is not.
 *
 * @param {Object}   deps     bridge, engine
 * @param {Object}   S        settings
 * @param {number}   maxSide  longest edge to read, 0 for full size
 * @param {Function} say      progress reporter
 */
function process( deps, S, maxSide, say ) {
	var bridge = deps.bridge;
	var engine = deps.engine;

	if ( ! engine || 1 !== engine.ENGINE_API ) {
		return Promise.reject( new Error(
			'This plugin and its imaging engine are different versions. Reinstall the plugin.'
		) );
	}

	var blocked = bridge.blocker();

	if ( blocked ) {
		return Promise.reject( new Error( blocked ) );
	}

	var settings = clampSettings( S );

	say( 'Reading the layer' );

	return bridge.read( maxSide ).then( function ( frame ) {
		say( 'Working' );

		engine.run(
			frame.data,
			frame.width,
			frame.height,
			settingsForEngine( settings ),
			frame.scale
		);

		var under = null;

		if ( settings.underbase ) {
			/* The underbase is measured in pixels, so like the halftone cell
			   it has to be scaled with the proxy or the preview lies about
			   the file. */
			under = engine.buildUnderbase(
				frame.data,
				frame.width,
				frame.height,
				Math.max( 0, Math.round( settings.choke * frame.scale ) )
			);
		}

		return { frame: frame, settings: settings, under: under };
	} );
}

/**
 * Run the pipeline over the active layer and write the result back.
 *
 * @param {Object} deps  bridge, engine
 * @param {Object} S     settings
 * @param {Object} opts  { onStage: fn }
 */
function apply( deps, S, opts ) {
	var options = opts || {};
	var say = options.onStage || function () {};

	return process( deps, S, 0, say ).then( function ( r ) {
		say( 'Writing it back' );

		return deps.bridge.write( r.frame, 'Print Lab' ).then( function () {
			return {
				width: r.frame.width,
				height: r.frame.height,
				scale: r.frame.scale,
				underbase: !! r.under,
				underbaseData: r.under
			};
		} );
	} );
}

/**
 * The same pipeline at preview size, WITHOUT writing to the document.
 *
 * This is the whole point of it being separate from apply(): looking at what
 * an ink colour is going to do should not put a step in anyone's history, and
 * should not have to be undone if the answer is no.
 *
 * @param {Object} deps  bridge, engine
 * @param {Object} S     settings
 * @param {Object} opts  { onStage: fn }
 */
function preview( deps, S, opts ) {
	var options = opts || {};
	var say = options.onStage || function () {};

	return process( deps, S, PREVIEW_MAX_SIDE, say ).then( function ( r ) {
		return {
			width: r.frame.width,
			height: r.frame.height,
			scale: r.frame.scale,
			data: r.frame.data,
			underbase: !! r.under,
			underbaseData: r.under
		};
	} );
}

module.exports = {
	defaults: defaults,
	ENGINE_KEYS: ENGINE_KEYS,
	DERIVED_KEYS: DERIVED_KEYS,
	screenColours: screenColours,
	autoInk: autoInk,
	parseColour: parseColour,
	settingsForEngine: settingsForEngine,
	clampSettings: clampSettings,
	PREVIEW_MAX_SIDE: PREVIEW_MAX_SIDE,
	apply: apply,
	preview: preview
};

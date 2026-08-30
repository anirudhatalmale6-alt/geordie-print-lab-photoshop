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
		hue: 0,
		saturation: 0,
		lightness: 0,

		knockout: [ 0, 0, 0 ],

		bgRemove: false,
		bgTolerance: 12,
		bgSoftness: 6,

		halftone: false,
		lpi: 30,
		angle: 22.5,
		shape: 'round',
		screenSource: 'dark',

		inkEnabled: false,
		ink: [ 0, 0, 0 ],

		/* Preview only - never sent to the engine, never printed. Same names
		   and same values as the web app so the two read alike. */
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
	'hue', 'saturation', 'lightness',
	'knockout',
	'bgRemove', 'bgTolerance', 'bgSoftness',
	'halftone', 'lpi', 'angle', 'shape', 'screenSource',
	'inkEnabled', 'ink',
	'levelsEnabled', 'inBlack', 'inGamma', 'inWhite', 'outBlack', 'outWhite',
	'microDot', 'cleanupIntensity',
	'underbase', 'choke'
];

function settingsForEngine( S ) {
	var out = {};

	ENGINE_KEYS.forEach( function ( k ) {
		out[ k ] = S[ k ];
	} );

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
	out.microDot = Math.min( 10, Math.max( 0, Number( out.microDot ) || 0 ) );
	out.cleanupIntensity = Math.min( 10, Math.max( 0, Number( out.cleanupIntensity ) || 0 ) );
	out.choke = Math.min( 20, Math.max( 0, Number( out.choke ) || 0 ) );

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

	return out;
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
	settingsForEngine: settingsForEngine,
	clampSettings: clampSettings,
	PREVIEW_MAX_SIDE: PREVIEW_MAX_SIDE,
	apply: apply,
	preview: preview
};

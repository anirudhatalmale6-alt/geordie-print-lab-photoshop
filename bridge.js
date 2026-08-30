/**
 * Everything that touches Photoshop, and nothing that does not.
 *
 * Kept in one file with the API injected rather than required at the top, so
 * the panel logic around it can be tested without Photoshop running.
 */

'use strict';

/* Photoshop hands back and takes 8-bit RGBA when asked for chunky data. The
   engine works in exactly that layout, which is why nothing has to be
   repacked between them. */
var COMPONENTS = 4;

function Bridge( ps ) {
	this.app = ps.app;
	this.core = ps.core;
	this.imaging = ps.imaging;
	this.constants = ps.constants || {};
}

/**
 * Why we cannot work on the current document, or '' if we can.
 *
 * Every one of these is a real thing a customer will hit, and each needs its
 * own sentence - "it didn't work" is not a message.
 */
Bridge.prototype.blocker = function () {
	var doc;

	try {
		doc = this.app.activeDocument;
	} catch ( e ) {
		doc = null;
	}

	if ( ! doc ) {
		return 'Open an image in Photoshop first.';
	}

	var mode = String( doc.mode || '' ).toLowerCase();

	/* The engine is RGB maths from end to end. CMYK or greyscale would come
	   out looking nothing like the preview, so it is refused rather than
	   silently wrong. */
	if ( mode && mode.indexOf( 'rgb' ) === -1 ) {
		return 'This works on RGB documents. Yours is ' + doc.mode +
			' - use Image > Mode > RGB Color, then try again.';
	}

	var depth = Number( doc.bitsPerChannel || doc.bitsPerPixel || 8 );

	if ( depth && depth !== 8 ) {
		return 'This works on 8 bit documents. Yours is ' + depth +
			' bit - use Image > Mode > 8 Bits/Channel, then try again.';
	}

	var layer = doc.activeLayers && doc.activeLayers.length ? doc.activeLayers[ 0 ] : null;

	if ( ! layer ) {
		return 'Select a layer to work on.';
	}

	var kind = String( layer.kind || '' ).toLowerCase();

	/* putPixels writes into a pixel layer. A text, shape, smart object or
	   adjustment layer has no pixels of its own to replace. */
	if ( kind && [ 'pixel', 'normal', 'background' ].indexOf( kind ) === -1 ) {
		return 'The selected layer is a ' + layer.kind +
			' layer. Rasterise it first, or pick a normal layer.';
	}

	if ( layer.locked ) {
		return 'That layer is locked. Unlock it and try again.';
	}

	return '';
};

Bridge.prototype.docInfo = function () {
	var doc = this.app.activeDocument;
	var layer = doc.activeLayers[ 0 ];

	return {
		documentID: doc.id,
		layerID: layer.id,
		name: doc.name,
		layerName: layer.name,
		width: doc.width,
		height: doc.height,
		resolution: doc.resolution
	};
};

/**
 * Read pixels out of the active layer.
 *
 * `maxSide` downscales for the preview. The engine takes a `scale` so that a
 * proxy produces the same DOTS as the full file rather than dots twice the
 * size, so the scale actually used is returned alongside.
 */
Bridge.prototype.read = function ( maxSide ) {
	var self = this;
	var info = this.docInfo();
	var opts = {
		documentID: info.documentID,
		layerID: info.layerID,
		componentSize: 8,
		applyAlpha: false
	};

	var longest = Math.max( info.width, info.height );
	var scale = 1;

	if ( maxSide && longest > maxSide ) {
		scale = maxSide / longest;
		opts.targetSize = {
			width: Math.max( 1, Math.round( info.width * scale ) ),
			height: Math.max( 1, Math.round( info.height * scale ) )
		};
	}

	return this.core.executeAsModal( function () {
		return self.imaging.getPixels( opts );
	}, { commandName: 'Print Lab: read pixels' } ).then( function ( result ) {
		var img = result.imageData;

		return img.getData( { chunky: true } ).then( function ( buf ) {
			var w = img.width;
			var h = img.height;

			/* getData can hand back RGB where the layer has no alpha. The
			   engine indexes in fours throughout, so a 3-component buffer
			   would be read as garbage from the second pixel onwards. */
			var components = Math.round( buf.length / ( w * h ) );
			var data;

			if ( COMPONENTS === components ) {
				data = new Uint8ClampedArray( buf );
			} else if ( 3 === components ) {
				data = new Uint8ClampedArray( w * h * 4 );
				for ( var i = 0, j = 0; i < buf.length; i += 3, j += 4 ) {
					data[ j ] = buf[ i ];
					data[ j + 1 ] = buf[ i + 1 ];
					data[ j + 2 ] = buf[ i + 2 ];
					data[ j + 3 ] = 255;
				}
			} else {
				img.dispose();
				throw new Error( 'Unexpected pixel layout from Photoshop (' + components + ' components).' );
			}

			img.dispose();

			return { data: data, width: w, height: h, scale: scale, info: info };
		} );
	} );
};

/**
 * Write pixels back into the layer they came from.
 *
 * Wrapped in a single history step so the customer's undo puts the artwork
 * back in one go rather than in pieces.
 */
Bridge.prototype.write = function ( frame, commandName ) {
	var self = this;

	return this.core.executeAsModal( function ( ctx ) {
		var hostControl = ctx && ctx.hostControl;
		var suspend = hostControl && hostControl.suspendHistory
			? hostControl.suspendHistory( {
				documentID: frame.info.documentID,
				name: commandName || 'Geordie Print Lab'
			} )
			: Promise.resolve( null );

		return Promise.resolve( suspend ).then( function ( token ) {
			var img = self.imaging.createImageDataFromBuffer( frame.data, {
				width: frame.width,
				height: frame.height,
				components: COMPONENTS,
				chunky: true,
				colorSpace: 'RGB',
				colorProfile: 'sRGB IEC61966-2.1'
			} );

			return self.imaging.putPixels( {
				documentID: frame.info.documentID,
				layerID: frame.info.layerID,
				imageData: img,
				replace: true
			} ).then( function () {
				img.dispose();

				if ( token !== null && hostControl && hostControl.resumeHistory ) {
					return hostControl.resumeHistory( token );
				}

				return undefined;
			}, function ( err ) {
				img.dispose();

				if ( token !== null && hostControl && hostControl.resumeHistory ) {
					/* Resume before rethrowing, or the document is left with
					   history suspended and every later edit is unrecordable. */
					return Promise.resolve( hostControl.resumeHistory( token ) ).then( function () {
						throw err;
					} );
				}

				throw err;
			} );
		} );
	}, { commandName: commandName || 'Geordie Print Lab' } );
};

module.exports = { Bridge: Bridge, COMPONENTS: COMPONENTS };

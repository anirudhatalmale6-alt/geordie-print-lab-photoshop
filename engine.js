/**
 * Prepress engine - the whole pixel pipeline, in a worker.
 *
 * Runs identically on the preview proxy and on the full-resolution export, so
 * what the customer sees on screen is what comes out of the file. The only
 * difference is `scale`: the halftone cell is measured in pixels, so a proxy
 * that is half the width has to use a cell half as wide or the dots would come
 * out twice the size on screen.
 *
 * Everything here is plain ImageData in, ImageData out. No DOM, no canvas.
 */

/* global self */

( function () {
	'use strict';

	/* ------------------------------------------------------------------ */
	/* Small helpers                                                       */
	/* ------------------------------------------------------------------ */

	function clamp255( v ) {
		return v < 0 ? 0 : ( v > 255 ? 255 : v );
	}

	function clamp01( v ) {
		return v < 0 ? 0 : ( v > 1 ? 1 : v );
	}

	/**
	 * Build a 256-entry lookup for a levels stage. Doing the pow() once per
	 * possible value rather than once per pixel is the difference between a
	 * live slider and a slideshow.
	 */
	function levelsLut( inBlack, inWhite, gamma, outBlack, outWhite ) {
		var lut = new Uint8ClampedArray( 256 );
		var span = inWhite - inBlack;
		var inv = 1 / ( gamma > 0.01 ? gamma : 0.01 );
		var i, v;

		if ( span <= 0 ) {
			span = 1;
		}

		for ( i = 0; i < 256; i++ ) {
			v = ( i - inBlack ) / span;
			v = clamp01( v );
			v = Math.pow( v, inv );
			lut[ i ] = clamp255( Math.round( outBlack + v * ( outWhite - outBlack ) ) );
		}

		return lut;
	}

	function applyLut( data, lut ) {
		var i;
		for ( i = 0; i < data.length; i += 4 ) {
			data[ i ] = lut[ data[ i ] ];
			data[ i + 1 ] = lut[ data[ i + 1 ] ];
			data[ i + 2 ] = lut[ data[ i + 2 ] ];
		}
	}

	/* ------------------------------------------------------------------ */
	/* Hue / saturation / lightness                                        */
	/* ------------------------------------------------------------------ */

	function rgbToHsl( r, g, b, out ) {
		r /= 255; g /= 255; b /= 255;

		var max = Math.max( r, g, b );
		var min = Math.min( r, g, b );
		var h = 0;
		var s = 0;
		var l = ( max + min ) / 2;
		var d = max - min;

		if ( d !== 0 ) {
			s = l > 0.5 ? d / ( 2 - max - min ) : d / ( max + min );

			if ( max === r ) {
				h = ( g - b ) / d + ( g < b ? 6 : 0 );
			} else if ( max === g ) {
				h = ( b - r ) / d + 2;
			} else {
				h = ( r - g ) / d + 4;
			}

			h /= 6;
		}

		out[ 0 ] = h;
		out[ 1 ] = s;
		out[ 2 ] = l;
	}

	function hueToRgb( p, q, t ) {
		if ( t < 0 ) { t += 1; }
		if ( t > 1 ) { t -= 1; }
		if ( t < 1 / 6 ) { return p + ( q - p ) * 6 * t; }
		if ( t < 1 / 2 ) { return q; }
		if ( t < 2 / 3 ) { return p + ( q - p ) * ( 2 / 3 - t ) * 6; }
		return p;
	}

	function hslToRgb( h, s, l, out ) {
		var q, p;

		if ( s === 0 ) {
			out[ 0 ] = out[ 1 ] = out[ 2 ] = Math.round( l * 255 );
			return;
		}

		q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s;
		p = 2 * l - q;

		out[ 0 ] = Math.round( hueToRgb( p, q, h + 1 / 3 ) * 255 );
		out[ 1 ] = Math.round( hueToRgb( p, q, h ) * 255 );
		out[ 2 ] = Math.round( hueToRgb( p, q, h - 1 / 3 ) * 255 );
	}

	function applyHsl( data, hue, sat, light ) {
		if ( ! hue && ! sat && ! light ) {
			return;
		}

		var hShift = hue / 360;
		var sMul = sat >= 0 ? 1 + sat / 100 : 1 + sat / 100;
		var lShift = light / 100;
		var hsl = [ 0, 0, 0 ];
		var rgb = [ 0, 0, 0 ];
		var i, h, s, l;

		for ( i = 0; i < data.length; i += 4 ) {
			if ( data[ i + 3 ] === 0 ) {
				continue;
			}

			rgbToHsl( data[ i ], data[ i + 1 ], data[ i + 2 ], hsl );

			h = hsl[ 0 ] + hShift;
			h = h - Math.floor( h );
			s = clamp01( hsl[ 1 ] * sMul );
			l = clamp01( hsl[ 2 ] + lShift );

			hslToRgb( h, s, l, rgb );

			data[ i ] = rgb[ 0 ];
			data[ i + 1 ] = rgb[ 1 ];
			data[ i + 2 ] = rgb[ 2 ];
		}
	}

	/* ------------------------------------------------------------------ */
	/* Background removal                                                  */
	/* ------------------------------------------------------------------ */

	/**
	 * Drop every pixel close to the knockout colour. Tolerance is a percentage
	 * of the longest possible RGB distance, and there is a soft band above it
	 * so edges do not come out with a hard jaggy fringe.
	 */
	function removeBackground( data, knock, tolerance, softness ) {
		var kr = knock[ 0 ];
		var kg = knock[ 1 ];
		var kb = knock[ 2 ];
		var maxDist = Math.sqrt( 3 * 255 * 255 );
		var hard = ( tolerance / 100 ) * maxDist;
		var soft = hard + ( softness / 100 ) * maxDist;
		var i, dr, dg, db, dist, t;

		if ( soft <= hard ) {
			soft = hard + 0.0001;
		}

		for ( i = 0; i < data.length; i += 4 ) {
			if ( data[ i + 3 ] === 0 ) {
				continue;
			}

			dr = data[ i ] - kr;
			dg = data[ i + 1 ] - kg;
			db = data[ i + 2 ] - kb;
			dist = Math.sqrt( dr * dr + dg * dg + db * db );

			if ( dist <= hard ) {
				data[ i + 3 ] = 0;
			} else if ( dist < soft ) {
				t = ( dist - hard ) / ( soft - hard );
				data[ i + 3 ] = clamp255( Math.round( data[ i + 3 ] * t ) );
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Halftone                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * Spot functions. Each ranks the points inside a cell by the order in which
	 * ink should reach them as the dot grows - 0 at the middle, biggest at
	 * whichever corner fills last. (u,v) run -0.5..0.5 from the cell centre.
	 *
	 * Only the ORDER matters here, not the scale. Turning that order into a
	 * threshold is buildScreen()'s job, below.
	 */
	var SPOTS = {
		round: function ( u, v ) {
			return u * u + v * v;
		},
		ellipse: function ( u, v ) {
			// Stretched on one axis, so dots chain into each other gradually
			// through the midtones instead of all joining up at once at 50%.
			return u * u * 0.72 + v * v * 1.4;
		},
		square: function ( u, v ) {
			return Math.abs( u ) > Math.abs( v ) ? Math.abs( u ) : Math.abs( v );
		},
		line: function ( u, v ) {
			return Math.abs( v );
		},
		diamond: function ( u, v ) {
			return Math.abs( u ) + Math.abs( v );
		}
	};

	var screenCache = {};

	/**
	 * Turn a spot function into a threshold table that is area-proportional.
	 *
	 * This is the step it is easy to get wrong, and getting it wrong is why
	 * halftones so often print darker than the screen promised. The instinct is
	 * to scale the spot function so it hits 1 at the corner of the cell, but
	 * that says nothing about AREA: a round dot whose radius is half the cell
	 * already covers pi/4, nearly 79% of it, so a 50% grey came out at 80% ink.
	 * Measured exactly that before this existed.
	 *
	 * So do not derive it - sample it. Evaluate the spot over the cell, sort
	 * the values, and read off the percentiles. levels[c] is then the spot
	 * value that exactly c/255 of the cell falls below, which makes "ink where
	 * spot < levels[coverage]" cover the right fraction by construction, for
	 * any shape, including ones with no tidy closed form.
	 */
	function buildScreen( shape ) {
		if ( screenCache[ shape ] ) {
			return screenCache[ shape ];
		}

		var spot = SPOTS[ shape ] || SPOTS.round;
		var N = 192;
		var vals = new Float64Array( N * N );
		var x, y, i;

		for ( y = 0; y < N; y++ ) {
			for ( x = 0; x < N; x++ ) {
				vals[ y * N + x ] = spot( ( x + 0.5 ) / N - 0.5, ( y + 0.5 ) / N - 0.5 );
			}
		}

		vals.sort();

		var last = vals.length - 1;
		var levels = new Float64Array( 256 );

		for ( i = 0; i < 256; i++ ) {
			levels[ i ] = vals[ Math.min( last, Math.round( i / 255 * last ) ) ];
		}

		screenCache[ shape ] = levels;

		return levels;
	}

	/**
	 * Screen the artwork into solid dots.
	 *
	 * The output is binary by definition: film cannot print a half-opaque
	 * pixel, so every pixel ends up either fully there or gone, and the
	 * illusion of a midtone comes from how many of them survive. Colour is
	 * never touched - only coverage is screened.
	 *
	 * What counts as "coverage" is the whole question, and it is not the same
	 * job every time:
	 *
	 *   opacity - screen what the artwork already says is soft. Right for a
	 *             glow or a feathered edge that has real alpha in it.
	 *   dark    - screen ink density for dark ink on a light garment. A white
	 *             pixel needs no ink, a black one needs all of it.
	 *   white   - the same idea inverted, for white ink on a dark garment.
	 *
	 * Alpha is always multiplied in on top, so a transparent pixel stays
	 * transparent whichever mode you pick.
	 */
	function halftone( data, w, h, opts ) {
		var cell = opts.cell;
		var spot = SPOTS[ opts.shape ] || SPOTS.round;
		var levels = buildScreen( opts.shape in SPOTS ? opts.shape : 'round' );
		var mode = opts.source;
		var rad = opts.angle * Math.PI / 180;
		var cos = Math.cos( rad );
		var sin = Math.sin( rad );
		var invCell = 1 / cell;
		var x, y, i, a, lum, base, cov, u, v, cu, cv, c;

		if ( cell < 1.2 ) {
			// Below about a pixel and a bit per cell there is no dot to draw -
			// screening here would just add noise, so leave it alone.
			return;
		}

		for ( y = 0; y < h; y++ ) {
			for ( x = 0; x < w; x++ ) {
				i = ( y * w + x ) * 4;
				a = data[ i + 3 ];

				if ( a === 0 ) {
					continue;
				}

				if ( mode === 'opacity' ) {
					base = 1;
				} else {
					lum = ( data[ i ] * 0.299 + data[ i + 1 ] * 0.587 + data[ i + 2 ] * 0.114 ) / 255;
					base = mode === 'white' ? lum : 1 - lum;
				}

				cov = ( a / 255 ) * base;

				if ( cov <= 0 ) {
					data[ i + 3 ] = 0;
					continue;
				}

				if ( cov >= 1 ) {
					data[ i + 3 ] = 255;
					continue;
				}

				// Rotate into screen space, then find where we sit inside the cell.
				cu = ( x * cos + y * sin ) * invCell;
				cv = ( -x * sin + y * cos ) * invCell;

				u = cu - Math.floor( cu ) - 0.5;
				v = cv - Math.floor( cv ) - 0.5;

				c = ( cov * 255 ) | 0;

				data[ i + 3 ] = spot( u, v ) < levels[ c ] ? 255 : 0;
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Cleanup                                                             */
	/* ------------------------------------------------------------------ */

	/**
	 * Micro-dot cleanup - drop ink pixels that have almost nothing around them.
	 *
	 * A screened highlight is a scatter of single pixels. Some of those are the
	 * gradient doing its job and some are dirt that will not survive the film,
	 * and the difference is how many neighbours they have.
	 */
	function microDot( data, w, h, level ) {
		if ( level < 1 ) {
			return;
		}

		var alpha = new Uint8Array( w * h );
		var i, p, x, y, n, yy, xx, keep;

		for ( p = 0, i = 3; p < alpha.length; p++, i += 4 ) {
			alpha[ p ] = data[ i ] > 127 ? 1 : 0;
		}

		var src = alpha.slice();

		for ( y = 0; y < h; y++ ) {
			for ( x = 0; x < w; x++ ) {
				p = y * w + x;

				if ( ! src[ p ] ) {
					continue;
				}

				n = 0;

				for ( yy = y - 1; yy <= y + 1; yy++ ) {
					if ( yy < 0 || yy >= h ) {
						continue;
					}
					for ( xx = x - 1; xx <= x + 1; xx++ ) {
						if ( xx < 0 || xx >= w || ( xx === x && yy === y ) ) {
							continue;
						}
						n += src[ yy * w + xx ];
					}
				}

				keep = n >= level;

				if ( ! keep ) {
					data[ p * 4 + 3 ] = 0;
				}
			}
		}
	}

	/**
	 * Cleanup intensity - the same idea over a wider window, for the sparse
	 * dots that live in shadows and highlights rather than on their own.
	 */
	function cleanupIntensity( data, w, h, intensity ) {
		if ( intensity <= 0 ) {
			return;
		}

		var need = ( intensity / 100 ) * 12; // out of 24 neighbours in a 5x5
		var alpha = new Uint8Array( w * h );
		var i, p, x, y, n, yy, xx;

		for ( p = 0, i = 3; p < alpha.length; p++, i += 4 ) {
			alpha[ p ] = data[ i ] > 127 ? 1 : 0;
		}

		for ( y = 0; y < h; y++ ) {
			for ( x = 0; x < w; x++ ) {
				p = y * w + x;

				if ( ! alpha[ p ] ) {
					continue;
				}

				n = 0;

				for ( yy = y - 2; yy <= y + 2; yy++ ) {
					if ( yy < 0 || yy >= h ) {
						continue;
					}
					for ( xx = x - 2; xx <= x + 2; xx++ ) {
						if ( xx < 0 || xx >= w || ( xx === x && yy === y ) ) {
							continue;
						}
						n += alpha[ yy * w + xx ];
					}
				}

				if ( n < need ) {
					data[ p * 4 + 3 ] = 0;
				}
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Ink colour                                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * Flatten every surviving pixel to one ink.
	 *
	 * A screen prints one colour. Up to here the dots have kept whatever colour
	 * the artwork happened to be, which is right for looking at and wrong for
	 * printing: the separation is a stencil, and the ink that goes through it is
	 * chosen at the press, not by the photograph.
	 *
	 * Alpha is left exactly as it is. The halftone decided which pixels are ink
	 * and that decision is not revisited here - this only says what colour the
	 * ink is, so turning it on can never change the shape of the print, only its
	 * colour. That is worth keeping true: it means switching ink cannot silently
	 * alter dot gain or coverage.
	 */
	function inkColour( data, rgb ) {
		var r = clamp255( rgb[ 0 ] );
		var g = clamp255( rgb[ 1 ] );
		var b = clamp255( rgb[ 2 ] );
		var i;

		for ( i = 0; i < data.length; i += 4 ) {
			if ( data[ i + 3 ] === 0 ) {
				continue;
			}

			data[ i ] = r;
			data[ i + 1 ] = g;
			data[ i + 2 ] = b;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Underbase                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Build the white layer that goes under the colour on a dark garment.
	 *
	 * Choked inwards by a few pixels, because a white base that is even
	 * slightly wider than the artwork shows as a halo round every edge, and on
	 * a black shirt that is the first thing anyone notices.
	 */
	function buildUnderbase( data, w, h, choke ) {
		var out = new Uint8ClampedArray( data.length );
		var mask = new Uint8Array( w * h );
		var i, p, x, y, k, yy, xx, solid;

		for ( p = 0, i = 3; p < mask.length; p++, i += 4 ) {
			mask[ p ] = data[ i ] > 8 ? 1 : 0;
		}

		for ( k = 0; k < choke; k++ ) {
			var prev = mask.slice();

			for ( y = 0; y < h; y++ ) {
				for ( x = 0; x < w; x++ ) {
					p = y * w + x;

					if ( ! prev[ p ] ) {
						continue;
					}

					solid = 1;

					for ( yy = y - 1; yy <= y + 1 && solid; yy++ ) {
						for ( xx = x - 1; xx <= x + 1; xx++ ) {
							if ( yy < 0 || yy >= h || xx < 0 || xx >= w || ! prev[ yy * w + xx ] ) {
								solid = 0;
								break;
							}
						}
					}

					mask[ p ] = solid;
				}
			}
		}

		for ( p = 0; p < mask.length; p++ ) {
			i = p * 4;
			out[ i ] = 255;
			out[ i + 1 ] = 255;
			out[ i + 2 ] = 255;
			out[ i + 3 ] = mask[ p ] ? 255 : 0;
		}

		return out;
	}

	/* ------------------------------------------------------------------ */
	/* The pipeline                                                        */
	/* ------------------------------------------------------------------ */

	/**
	 * Order matters and it is the same order the panels are stacked in, top to
	 * bottom, so what you read down the sidebar is what happens to the pixels.
	 *
	 * `scale` is proxy width over full width. Everything measured in pixels -
	 * the halftone cell, the choke, the cleanup window - has to be multiplied
	 * by it or the preview lies about the file.
	 */
	function run( data, w, h, s, scale ) {
		var lut;

		// 1. Image adjustments - levels, then hue/saturation.
		if ( s.adjEnabled ) {
			lut = levelsLut( s.adjBlack, s.adjWhite, s.adjGamma, 0, 255 );
			applyLut( data, lut );
			applyHsl( data, s.hue, s.saturation, s.lightness );
		}

		// 2. Background removal, using the knockout colour from Shirt Color.
		if ( s.bgRemove ) {
			removeBackground( data, s.knockout, s.bgTolerance, s.bgSoftness );
		}

		// 3. Halftone screen.
		if ( s.halftone ) {
			halftone( data, w, h, {
				cell: Math.max( 1, ( s.dpi / s.lpi ) * scale ),
				angle: s.angle,
				shape: s.shape,
				source: s.screenSource
			} );
		}

		// 4. Levels - the print-side one, after screening, so it trims the
		//    separation rather than the artwork.
		if ( s.levelsEnabled ) {
			lut = levelsLut( s.inBlack, s.inWhite, s.inGamma, s.outBlack, s.outWhite );
			applyLut( data, lut );
		}

		// 5. Cleanup - only meaningful once there are dots to clean.
		if ( s.halftone ) {
			if ( s.microDot > 0 ) {
				microDot( data, w, h, s.microDot );
			}
			if ( s.cleanupIntensity > 0 ) {
				cleanupIntensity( data, w, h, s.cleanupIntensity );
			}
		}

		// 6. Ink colour, last, because it is the last word on RGB.
		//    Step 4 pushes every channel through a lookup table and steps 3 and
		//    5 decide alpha; colouring before either would mean the ink that
		//    came out was not the ink that was picked.
		if ( s.inkEnabled ) {
			inkColour( data, s.ink );
		}

		return data;
	}

	/* ------------------------------------------------------------------ */
	/* Worker plumbing                                                     */
	/* ------------------------------------------------------------------ */

	function handle( msg ) {
		var d = msg.data;
		var pixels = new Uint8ClampedArray( d.buf );
		var result = { id: d.id, w: d.w, h: d.h, export: !! d.export };
		var transfer = [];
		var under;

		run( pixels, d.w, d.h, d.settings, d.scale );

		if ( d.settings.underbase ) {
			under = buildUnderbase(
				pixels,
				d.w,
				d.h,
				Math.max( 0, Math.round( d.settings.choke * d.scale ) )
			);
			result.under = under.buffer;
			transfer.push( under.buffer );
		}

		result.buf = pixels.buffer;
		transfer.push( pixels.buffer );

		self.postMessage( result, transfer );
	}

	if ( typeof self !== 'undefined' && typeof self.postMessage === 'function' ) {
		self.onmessage = handle;
	}

	/* ------------------------------------------------------------------ */
	/* The same file, called directly                                      */
	/* ------------------------------------------------------------------ */

	/*
	 * The Photoshop plugin has no Worker to post messages to - UXP does not
	 * provide one - so it calls straight in. Publishing the two entry points
	 * costs nothing and changes nothing above this line: the worker path is
	 * untouched, and there is exactly one copy of the maths, so the plugin
	 * cannot drift away from the website.
	 *
	 * ENGINE_API is bumped only when the shape of run() or buildUnderbase()
	 * changes, never for a change in the maths - the plugin checks it so a
	 * mismatched pair fails loudly instead of producing quiet nonsense.
	 */
	var api = {
		ENGINE_API: 1,
		run: run,
		buildUnderbase: buildUnderbase
	};

	if ( typeof module !== 'undefined' && module.exports ) {
		module.exports = api;
	}

	if ( typeof globalThis !== 'undefined' ) {
		globalThis.BPT_ENGINE = api;
	}
}() );

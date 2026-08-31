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

	/**
	 * The smooth S between 0 and 1, and its exact inverse.
	 *
	 * Both are pinned: 0 maps to 0 and 1 maps to 1, whatever happens between.
	 * That pinning is the whole point of using them for contrast, and the
	 * inverse is a closed form rather than a table so the two directions of the
	 * slider are exactly each other's undo.
	 */
	function smoothStep( x ) {
		return x * x * ( 3 - 2 * x );
	}

	function unSmoothStep( x ) {
		return 0.5 - Math.sin( Math.asin( 1 - 2 * x ) / 3 );
	}

	/**
	 * Brightness and contrast, folded into a lookup that already exists.
	 *
	 * Both are per-channel functions of one input value, exactly like levels, so
	 * pushing the levels table through them costs 256 operations and leaves
	 * Image Adjustments as a single pass over the pixels.
	 *
	 * Both are CURVES, not offsets, and that is the whole difference between
	 * this and what was here before.
	 *
	 * Brightness used to add a flat number to every channel. That is what
	 * Photoshop did until 2007 and what it stopped doing, because it wrecks
	 * saturated colour: adding 40 to a pure green takes 0,255,0 to 40,255,40,
	 * and the green channel was already at the top so the only thing that
	 * actually changed was that red and blue came up. The colour did not get
	 * brighter, it got paler. A gamma-shaped lift instead leaves both ends where
	 * they are and moves the middle, so a pure green brightens as a green and a
	 * channel already at 255 is not asked to go further. Base 3 puts the full
	 * slider at a gamma of 1/3 up and 3 down, which is a real adjustment without
	 * being a destructive one.
	 *
	 * Contrast used to be the standard pivot-on-mid-grey multiply, which clips:
	 * at the top of the slider everything but the midtones is crushed to black
	 * or blown to white, and clipped detail is gone for good. Blending towards
	 * the smooth S curve instead steepens the middle while still passing through
	 * 0 and 255, so it can be wound all the way up and wound back down again
	 * with the shadows and highlights still there.
	 *
	 * Brightness is applied first, which is the order Photoshop uses, and it
	 * matters: contrast afterwards works on the lifted image rather than the
	 * original.
	 */
	function brightContrast( lut, brightness, contrast ) {
		if ( ! brightness && ! contrast ) {
			return lut;
		}

		var gamma = Math.pow( 3, -brightness / 100 );
		var k = Math.abs( contrast ) / 100;
		var i, x;

		for ( i = 0; i < 256; i++ ) {
			x = lut[ i ] / 255;

			if ( brightness ) {
				x = Math.pow( x, gamma );
			}

			if ( contrast > 0 ) {
				x = x * ( 1 - k ) + smoothStep( x ) * k;
			} else if ( contrast < 0 ) {
				x = x * ( 1 - k ) + unSmoothStep( x ) * k;
			}

			lut[ i ] = clamp255( Math.round( x * 255 ) );
		}

		return lut;
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
	/* Vibrance                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * Saturation that knows when to stop.
	 *
	 * The plain saturation slider multiplies every pixel by the same number,
	 * which means the colours that were already strong are the first to clip.
	 * On a design that is mostly one flat brand colour that is the only thing
	 * it does: the flat colour goes to the edge of the gamut and stops, and
	 * everything muted around it has barely moved.
	 *
	 * Vibrance weights the lift by two things multiplied together:
	 *
	 *   s / (s + 0.15)   opens up as there starts to be a colour at all, so a
	 *                    pixel that is very nearly grey is barely touched.
	 *   (1 - s)squared   closes down as the colour approaches full strength.
	 *
	 * The falloff has to be the steep one. The obvious weight - 4s(1-s), a
	 * hump with its peak at half saturation - was measured and is far too flat
	 * to be worth having: it sits above 0.9 for everything between a quarter
	 * and three quarters saturated, so on the full slider a muted colour gained
	 * 0.48 and an already-vivid one at the same hue gained 0.35. That is a
	 * saturation slider with extra steps. The pair above gives the muted colour
	 * roughly seven times the lift, which is the whole point.
	 *
	 * The result is monotonic in saturation across all 256 input levels, in
	 * both directions of the slider - checked, not assumed. If it were not,
	 * two colours could swap places and a gradient would band.
	 *
	 * Greys are skipped outright rather than merely weighted to zero. A grey
	 * pixel has no hue - `rgbToHsl` returns whichever channel happened to be
	 * largest - so saturating one would invent a colour out of rounding.
	 *
	 * Skin is held back near hue 25, up to about two thirds, for the same reason
	 * Photoshop does it: a face is the one thing in a photograph that everybody
	 * can tell is wrong, and saturating it is what makes it look sunburnt.
	 */
	function applyVibrance( data, amount ) {
		if ( ! amount ) {
			return;
		}

		var k = amount / 100;
		var hsl = [ 0, 0, 0 ];
		var rgb = [ 0, 0, 0 ];
		var i, s, w, deg, d, ns;

		for ( i = 0; i < data.length; i += 4 ) {
			if ( data[ i + 3 ] === 0 ) {
				continue;
			}

			rgbToHsl( data[ i ], data[ i + 1 ], data[ i + 2 ], hsl );
			s = hsl[ 1 ];

			if ( s === 0 ) {
				continue;
			}

			/* The (1-s)squared falloff is what makes this vibrance rather than
			   saturation, and it applies in both directions. The s/(s+0.15)
			   gate only applies going UP: it is there to stop a colour being
			   manufactured in a pixel that had almost none, and there is no
			   such risk on the way down - taking the last of the colour out of
			   a nearly-grey pixel is precisely what the slider was asked to
			   do. Keeping the gate on the way down was measured and made the
			   negative end useless: a muted blue only lost a third of its
			   saturation at the very bottom of the slider. */
			w = ( 1 - s ) * ( 1 - s );

			if ( k >= 0 ) {
				w *= s / ( s + 0.15 );
			}

			deg = hsl[ 0 ] * 360;
			d = Math.abs( deg - 25 );

			if ( d > 180 ) {
				d = 360 - d;
			}

			if ( d < 30 ) {
				w *= 1 - 0.65 * ( 1 - d / 30 );
			}

			/* Bounded by whichever end it is heading for, so the full slider
			   lands exactly on grey or exactly on the edge of the gamut and
			   never has to be clipped back from beyond it. */
			ns = clamp01( s + k * w * ( k >= 0 ? 1 - s : s ) );

			if ( ns === s ) {
				continue;
			}

			hslToRgb( hsl[ 0 ], ns, hsl[ 2 ], rgb );
			data[ i ] = rgb[ 0 ];
			data[ i + 1 ] = rgb[ 1 ];
			data[ i + 2 ] = rgb[ 2 ];
		}
	}

	/* ------------------------------------------------------------------ */
	/* Brightness of one colour at a time                                  */
	/* ------------------------------------------------------------------ */

	/*
	 * The six hue families Photoshop uses, in degrees. They are 60 apart, which
	 * is what makes the weighting below add up to exactly one.
	 */
	var BANDS = [ 0, 60, 120, 180, 240, 300 ];

	/**
	 * How much to lift or drop the lightness at each of the 360 hues.
	 *
	 * A hue is not a category - orange is genuinely half red and half yellow -
	 * so each band's pull falls off linearly to nothing 60 degrees away. With
	 * the centres 60 apart that means exactly two bands reach any given hue and
	 * their weights sum to 1: no hue is counted twice and none is missed, which
	 * a set of hard boundaries could not promise. Pure orange with reds at -50
	 * and yellows at 0 lands on -25, which is what the eye expects.
	 *
	 * Built once per run as a 360-entry table rather than recomputed per pixel:
	 * six distances and a wrap for every pixel of a 1500px proxy is millions of
	 * operations for 360 distinct answers.
	 */
	/**
	 * Circular distance between two hue angles, 0 to 180.
	 */
	function hueGap( a, b ) {
		var d = Math.abs( a - b ) % 360;

		return d > 180 ? 360 - d : d;
	}

	/**
	 * One colour of the customer's own choosing, taken out of the six families.
	 *
	 * The six are 60 apart, so a hue landing between two centres is genuinely
	 * shared between them - which is right for orange and wrong for a garment
	 * colour somebody actually sells. A lime green at hue 92 is 54 percent green
	 * and 46 percent yellow, so the Greens slider only has half the say over it
	 * and the Yellows slider drags it about; that is the "green is picking up as
	 * yellow" fault, and it is arithmetic, not a bug in the bands.
	 *
	 * The fix is NOT to move a band centre. Moving Greens from 120 down to 92
	 * would fix the lime and hand pure green over to the Cyans slider, trading
	 * one surprise for another. Instead this window REPLACES the six families
	 * inside itself: at the picked hue the six contribute nothing and the one
	 * slider owns it outright, fading back to normal at the edge of the window.
	 * Nothing outside the window changes at all.
	 *
	 * @param {number} deg   Hue being asked about.
	 * @param {number} pick  Picked hue, or -1 for none.
	 * @param {number} width Half-width of the window in degrees.
	 * @return {number} 0 to 1: how much of this hue the picked colour owns.
	 */
	function pickWeight( deg, pick, width ) {
		if ( pick < 0 || width <= 0 ) {
			return 0;
		}

		var d = hueGap( deg, pick );

		return d >= width ? 0 : 1 - d / width;
	}

	function bandTable( amounts, pick, pickWidth, pickAmount ) {
		var table = new Float32Array( 360 );
		var deg, k, d, total, w;

		for ( deg = 0; deg < 360; deg++ ) {
			total = 0;

			for ( k = 0; k < 6; k++ ) {
				d = hueGap( deg, BANDS[ k ] );

				if ( d < 60 ) {
					total += ( 1 - d / 60 ) * ( amounts[ k ] || 0 ) / 100;
				}
			}

			w = pickWeight( deg, pick, pickWidth );

			if ( w > 0 ) {
				total = total * ( 1 - w ) + ( pickAmount / 100 ) * w;
			}

			table[ deg ] = total;
		}

		return table;
	}

	/**
	 * Lighten or darken one colour family without touching the others.
	 *
	 * The shift is multiplied by saturation on purpose. A grey pixel has no hue
	 * to belong to - whatever `rgbToHsl` returns for it is an artefact of which
	 * channel happened to be largest - so letting the reds slider move greys
	 * would move them by whichever way the rounding fell. Weighting by
	 * saturation makes the effect fade out exactly as the colour does.
	 */
	function applyBandLight( data, amounts, pick, pickWidth, pickAmount ) {
		var k, any = false;

		for ( k = 0; k < 6; k++ ) {
			if ( amounts[ k ] ) {
				any = true;
			}
		}

		/* The picked window is worth a pass on its own even with every family
		   at zero, because inside the window it is the only thing speaking. */
		if ( pick >= 0 && pickWidth > 0 && pickAmount ) {
			any = true;
		}

		if ( ! any ) {
			return;
		}

		var table = bandTable( amounts, pick, pickWidth, pickAmount );
		var hsl = [ 0, 0, 0 ];
		var rgb = [ 0, 0, 0 ];
		var i, deg, shift, l;

		for ( i = 0; i < data.length; i += 4 ) {
			if ( data[ i + 3 ] === 0 ) {
				continue;
			}

			rgbToHsl( data[ i ], data[ i + 1 ], data[ i + 2 ], hsl );

			/* `rgbToHsl` cannot return 1, but a read one past the end of a
			   typed array is `undefined` and turns the pixel black rather than
			   throwing, so the wrap is not left to trust. */
			deg = ( hsl[ 0 ] * 360 ) | 0;

			if ( deg > 359 ) {
				deg = 359;
			}

			shift = table[ deg ] * hsl[ 1 ];

			if ( shift === 0 ) {
				continue;
			}

			l = clamp01( hsl[ 2 ] + shift );

			hslToRgb( hsl[ 0 ], hsl[ 1 ], l, rgb );

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
	 *   garment - work it out from the two colours that actually decide it: the
	 *             garment being printed on and the ink going down. See below.
	 *
	 * Alpha is always multiplied in on top, so a transparent pixel stays
	 * transparent whichever mode you pick.
	 *
	 * WHY `garment` EXISTS
	 *
	 * `dark` and `white` are the same question asked about the two ends of the
	 * scale, and they are only right at those two ends. On a sport grey tee
	 * neither is: `dark` says a mid grey pixel needs half the ink, when on a
	 * garment that is already that grey it needs none at all. Anything printed
	 * on red, navy or bottle green has the same problem, which is the whole of
	 * "it only works on white and black shirts".
	 *
	 * The honest answer does not need a mode at all, it needs the two colours.
	 * Coverage is where the pixel sits on the line from the garment colour to
	 * the ink colour: on the garment it is 0 and no dot is laid, on the ink it
	 * is 1 and the dot is solid, and in between it is the dot percentage. It is
	 * a projection rather than a distance, so a pixel that is off to the side of
	 * that line - a colour this one ink cannot reproduce at all - resolves to
	 * the nearest amount of ink that this ink can actually make, instead of
	 * being read as a large amount of it.
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
		var gr = 0, gg = 0, gb = 0, dr = 0, dg = 0, db = 0, invLen = 0;
		var x, y, i, a, lum, base, cov, u, v, cu, cv, c;

		if ( cell < 1.2 ) {
			// Below about a pixel and a bit per cell there is no dot to draw -
			// screening here would just add noise, so leave it alone.
			return;
		}

		if ( mode === 'garment' ) {
			var g = opts.garment;
			var k = opts.ink;

			gr = g[ 0 ]; gg = g[ 1 ]; gb = g[ 2 ];
			dr = k[ 0 ] - gr; dg = k[ 1 ] - gg; db = k[ 2 ] - gb;

			var len = dr * dr + dg * dg + db * db;

			/* Ink the same colour as the garment. There is no line to project
			   onto and no print to make either, so rather than divide by zero
			   fall back to the behaviour that at least still produces a
			   separation. */
			if ( len < 1 ) {
				mode = 'dark';
			} else {
				invLen = 1 / len;
			}
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
				} else if ( mode === 'garment' ) {
					base = clamp01( (
						( data[ i ] - gr ) * dr +
						( data[ i + 1 ] - gg ) * dg +
						( data[ i + 2 ] - gb ) * db
					) * invLen );
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

		// 1. Image adjustments - levels with brightness and contrast folded into
		//    the same lookup, then hue/saturation, then the per-colour
		//    brightness. Order matters: the colour bands are asked which hue a
		//    pixel is, so they have to run after anything that moves hues.
		if ( s.adjEnabled ) {
			lut = brightContrast(
				levelsLut( s.adjBlack, s.adjWhite, s.adjGamma, 0, 255 ),
				s.brightness || 0,
				s.contrast || 0
			);
			applyLut( data, lut );
			applyHsl( data, s.hue, s.saturation, s.lightness );

			/* After the plain saturation, not before. Vibrance's whole job is
			   to lift what is still muted, so it has to be asked that question
			   about the image as it now is rather than as it arrived. */
			applyVibrance( data, s.vibrance || 0 );

			/* A pick of -1 means none. Anything outside 0..359 is treated as
			   none rather than wrapped: a hue that arrived out of range is a
			   sign something upstream is wrong, and silently wrapping it would
			   apply the slider to whatever colour the wrap happened to land on. */
			/* Floored, not rounded, because the table is looked up at
			   `( hue * 360 ) | 0` and the two have to agree. Rounding a pick of
			   92.5 up to 93 while the pixel it was taken from reads as 92 would
			   leave the picked colour one degree outside its own window - a
			   small residue of the six families would still reach it, which is
			   exactly the thing this is here to stop. */
			var pick = typeof s.bandPick === 'number' && s.bandPick >= 0 && s.bandPick < 360 ?
				Math.floor( s.bandPick ) : -1;

			applyBandLight( data, [
				s.lightRed || 0,
				s.lightYellow || 0,
				s.lightGreen || 0,
				s.lightCyan || 0,
				s.lightBlue || 0,
				s.lightMagenta || 0
			], pick, Math.max( 5, Math.min( 180, s.bandPickWidth || 20 ) ), s.lightPick || 0 );
		}

		// 2. Background removal, using the knockout colour from Shirt Color.
		if ( s.bgRemove ) {
			removeBackground( data, s.knockout, s.bgTolerance, s.bgSoftness );
		}

		// 3. Halftone screen.
		if ( s.halftone ) {
			var source = s.screenSource;

			/* A project saved before the garment mode existed can name it - the
			   settings are stored by name - but carries neither colour. Falling
			   back is the only option that reopens that project as it was
			   rather than as a black rectangle. */
			if ( 'garment' === source && ! ( s.screenGarment && s.screenInk ) ) {
				source = 'dark';
			}

			halftone( data, w, h, {
				cell: Math.max( 1, ( s.dpi / s.lpi ) * scale ),
				angle: s.angle,
				shape: s.shape,
				source: source,
				garment: s.screenGarment,
				ink: s.screenInk
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

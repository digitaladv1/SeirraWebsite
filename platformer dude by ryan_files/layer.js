// ECMAScript 5 strict mode
"use strict";

assert2(cr, "cr namespace not created");

(function()
{
	function sort_by_zindex(a, b)
	{
		return a.zindex - b.zindex;
	};
	
	// Layer class
	function Layer(layout, m)
	{
		// Runtime members
		this.layout = layout;
		this.runtime = layout.runtime;
		this.instances = [];        // running instances
		this.scale = 1.0;
		this.angle = 0;
		this.disableAngle = false;
		
		this.tmprect = new cr.rect(0, 0, 0, 0);
		this.tmpquad = new cr.quad();
		
		this.viewLeft = 0;
		this.viewRight = 0;
		this.viewTop = 0;
		this.viewBottom = 0;
		
		//this.number assigned by layout when created
		
		// Lazy-assigned instance Z indices
		this.zindices_stale = false;
		this.zindices_stale_from = -1;		// first index that has changed, or -1 if no bound
		
		this.clear_earlyz_index = 0;
		
		// Data model values
		this.name = m[0];
		this.index = m[1];
		this.sid = m[2];
		this.visible = m[3];		// initially visible
		this.background_color = m[4];
		this.transparent = m[5];
		this.parallaxX = m[6];
		this.parallaxY = m[7];
		this.opacity = m[8];
		this.forceOwnTexture = m[9];
		this.useRenderCells = m[10];
		this.zoomRate = m[11];
		this.blend_mode = m[12];
		this.effect_fallback = m[13];
		this.compositeOp = "source-over";
		this.srcBlend = 0;
		this.destBlend = 0;
		
		// If using render cells, create a RenderGrid to sort instances in to and a set of instances
		// needing bounding box updates
		this.render_grid = null;
		
		// Last render list in case not changed
		this.last_render_list = alloc_arr();
		this.render_list_stale = true;
		this.last_render_cells = new cr.rect(0, 0, -1, -1);
		this.cur_render_cells = new cr.rect(0, 0, -1, -1);
		
		if (this.useRenderCells)
		{
			this.render_grid = new cr.RenderGrid(this.runtime.original_width, this.runtime.original_height);
		}
		
		this.render_offscreen = false;
		
		// Initialise initial instances
		var im = m[14];
		var i, len;
		this.startup_initial_instances = [];		// for restoring initial_instances after load
		this.initial_instances = [];
		this.created_globals = [];		// global object UIDs already created - for save/load to avoid recreating
		
		for (i = 0, len = im.length; i < len; i++)
		{
			var inst = im[i];
			var type = this.runtime.types_by_index[inst[1]];
			assert2(type, "Could not find object type: " + inst.type_name);
			
			// If type has no default instance properties, make it this one
			if (!type.default_instance)
			{
				type.default_instance = inst;
				type.default_layerindex = this.index;
			}
				
			this.initial_instances.push(inst);
			
			if (this.layout.initial_types.indexOf(type) === -1)
				this.layout.initial_types.push(type);
		}
		
		cr.shallowAssignArray(this.startup_initial_instances, this.initial_instances);
		
		// Assign shaders
		this.effect_types = [];
		this.active_effect_types = [];
		this.shaders_preserve_opaqueness = true;
		this.effect_params = [];
		
		for (i = 0, len = m[15].length; i < len; i++)
		{
			this.effect_types.push({
				id: m[15][i][0],
				name: m[15][i][1],
				shaderindex: -1,
				preservesOpaqueness: false,
				active: true,
				index: i
			});
			
			this.effect_params.push(m[15][i][2].slice(0));
		}
		
		this.updateActiveEffects();
		
		this.rcTexBounce = new cr.rect(0, 0, 1, 1);
		this.rcTexDest = new cr.rect(0, 0, 1, 1);
		this.rcTexOrigin = new cr.rect(0, 0, 1, 1);
	};
	
	Layer.prototype.updateActiveEffects = function ()
	{
		cr.clearArray(this.active_effect_types);
		
		this.shaders_preserve_opaqueness = true;
		
		var i, len, et;
		for (i = 0, len = this.effect_types.length; i < len; i++)
		{
			et = this.effect_types[i];
			
			if (et.active)
			{
				this.active_effect_types.push(et);
				
				if (!et.preservesOpaqueness)
					this.shaders_preserve_opaqueness = false;
			}
		}
	};
	
	Layer.prototype.getEffectByName = function (name_)
	{
		var i, len, et;
		for (i = 0, len = this.effect_types.length; i < len; i++)
		{
			et = this.effect_types[i];
			
			if (et.name === name_)
				return et;
		}
		
		return null;
	};

	Layer.prototype.createInitialInstances = function (created_instances)
	{
		var i, k, len, inst, initial_inst, type, keep, hasPersistBehavior;
		for (i = 0, k = 0, len = this.initial_instances.length; i < len; i++)
		{
			initial_inst = this.initial_instances[i];
			type = this.runtime.types_by_index[initial_inst[1]];
			assert2(type, "Null type in initial instance");
			
			hasPersistBehavior = this.runtime.typeHasPersistBehavior(type);
			keep = true;
			
			// Only create objects with the persist behavior on the first visit
			if (!hasPersistBehavior || this.layout.first_visit)
			{
				inst = this.runtime.createInstanceFromInit(initial_inst, this, true);
				
				if (!inst)
					continue;		// may have skipped creation due to fallback effect "destroy"
				
				created_instances.push(inst);
				
				// Remove global objects from the initial instances list
				if (inst.type.global)
				{
					keep = false;
					this.created_globals.push(inst.uid);
				}
			}
			
			if (keep)
			{
				this.initial_instances[k] = this.initial_instances[i];
				k++;
			}
		}
		
		this.initial_instances.length = k;
		
		this.runtime.ClearDeathRow();		// flushes creation row so IIDs will be correct
		
		// Set the blend mode if fallback requires
		if (!this.runtime.glwrap && this.effect_types.length)	// no WebGL renderer and shaders used
			this.blend_mode = this.effect_fallback;				// use fallback blend mode
		
		// Set the blend mode variables
		this.compositeOp = cr.effectToCompositeOp(this.blend_mode);
		
		if (this.runtime.gl)
			cr.setGLBlend(this, this.blend_mode, this.runtime.gl);
		
		this.render_list_stale = true;
	};
	
	Layer.prototype.recreateInitialObjects = function (only_type, rc)
	{
		var i, len, initial_inst, type, wm, x, y, inst, j, lenj, s;
		var types_by_index = this.runtime.types_by_index;
		var only_type_is_family = only_type.is_family;
		var only_type_members = only_type.members;
		
		for (i = 0, len = this.initial_instances.length; i < len; ++i)
		{
			initial_inst = this.initial_instances[i];
			
			// Check initial_inst origin is within rectangle
			wm = initial_inst[0];
			x = wm[0];
			y = wm[1];
			
			if (!rc.contains_pt(x, y))
				continue;		// not in the given area
			
			type = types_by_index[initial_inst[1]];
			
			if (type !== only_type)
			{
				if (only_type_is_family)
				{
					// 'type' is not in the family 'only_type'
					if (only_type_members.indexOf(type) < 0)
						continue;
				}
				else
					continue;		// only_type is not a family, and the initial inst type does not match
			}
			
			// OK to create it
			inst = this.runtime.createInstanceFromInit(initial_inst, this, false);
			
			// Fire 'On created' for this instance
			this.runtime.isInOnDestroy++;
		
			this.runtime.trigger(Object.getPrototypeOf(type.plugin).cnds.OnCreated, inst);
			
			if (inst.is_contained)
			{
				for (j = 0, lenj = inst.siblings.length; j < lenj; j++)
				{
					s = inst.siblings[i];
					this.runtime.trigger(Object.getPrototypeOf(s.type.plugin).cnds.OnCreated, s);
				}
			}
			
			this.runtime.isInOnDestroy--;
		}
	};
	
	Layer.prototype.removeFromInstanceList = function (inst, remove_from_grid)
	{
		var index = cr.fastIndexOf(this.instances, inst);
		
		if (index < 0)
			return;		// not found
		
		// When using render cells, if remove_from_grid is specified then also remove it from
		// the layer render grid. Skip this if right < left, since that means it's not in the grid.
		if (remove_from_grid && this.useRenderCells && inst.rendercells && inst.rendercells.right >= inst.rendercells.left)
		{
			inst.update_bbox();											// make sure actually in its current rendercells
			this.render_grid.update(inst, inst.rendercells, null);		// no new range provided - remove only
			inst.rendercells.set(0, 0, -1, -1);							// set to invalid state to indicate not inserted
		}
		
		// If instance is at top of list, we can pop it off without making the Z indices stale
		if (index === this.instances.length - 1)
			this.instances.pop();
		else
		{	
			// otherwise have to splice it out
			cr.arrayRemove(this.instances, index);
			this.setZIndicesStaleFrom(index);
		}
		
		this.render_list_stale = true;
	};
	
	Layer.prototype.appendToInstanceList = function (inst, add_to_grid)
	{
		assert2(inst.layer === this, "Adding instance to wrong layer");
		
		// Since we know the instance is going to the top we can assign its Z index
		// without making all Z indices stale
		inst.zindex = this.instances.length;
		this.instances.push(inst);
		
		if (add_to_grid && this.useRenderCells && inst.rendercells)
		{
			inst.set_bbox_changed();		// will cause immediate update and new insertion to grid
		}
		
		this.render_list_stale = true;
	};
	
	Layer.prototype.prependToInstanceList = function (inst, add_to_grid)
	{
		assert2(inst.layer === this, "Adding instance to wrong layer");
		
		this.instances.unshift(inst);
		this.setZIndicesStaleFrom(0);
		
		if (add_to_grid && this.useRenderCells && inst.rendercells)
		{
			inst.set_bbox_changed();		// will cause immediate update and new insertion to grid
		}
	};
	
	Layer.prototype.moveInstanceAdjacent = function (inst, other, isafter)
	{
		assert2(inst.layer === this && other.layer === this, "Can't arrange Z order unless both objects on this layer");
		
		// Now both objects are definitely on the same layer: move in the Z order.
		var myZ = inst.get_zindex();
		var insertZ = other.get_zindex();
		
		cr.arrayRemove(this.instances, myZ);
		
		// if myZ is lower than insertZ, insertZ will have shifted down one index
		if (myZ < insertZ)
			insertZ--;
			
		// if inserting after object, increment the insert index
		if (isafter)
			insertZ++;
			
		// insertZ may now be pointing at the end of the array. If so, push instead of splice
		if (insertZ === this.instances.length)
			this.instances.push(inst);
		else
			this.instances.splice(insertZ, 0, inst);
			
		this.setZIndicesStaleFrom(myZ < insertZ ? myZ : insertZ);
	};
	
	Layer.prototype.setZIndicesStaleFrom = function (index)
	{
		// Keep track of the lowest index zindices are stale from
		if (this.zindices_stale_from === -1)			// not yet set
			this.zindices_stale_from = index;
		else if (index < this.zindices_stale_from)		// determine minimum z index affected
			this.zindices_stale_from = index;
		
		this.zindices_stale = true;
		this.render_list_stale = true;
	};
	
	Layer.prototype.updateZIndices = function ()
	{
		if (!this.zindices_stale)
			return;
		
		if (this.zindices_stale_from === -1)
			this.zindices_stale_from = 0;
		
		var i, len, inst;
		
		// When using render cells, this instance's Z index has changed and therefore is probably
		// no longer in the correct sort order in its render cell. Make sure the render cell
		// knows it needs sorting.
		if (this.useRenderCells)
		{
			for (i = this.zindices_stale_from, len = this.instances.length; i < len; ++i)
			{
				inst = this.instances[i];
				inst.zindex = i;
				this.render_grid.markRangeChanged(inst.rendercells);
			}
		}
		else
		{
			for (i = this.zindices_stale_from, len = this.instances.length; i < len; ++i)
			{
				this.instances[i].zindex = i;
			}
		}
		
		this.zindices_stale = false;
		this.zindices_stale_from = -1;
	};
	
	Layer.prototype.getScale = function (include_aspect)
	{
		return this.getNormalScale() * (this.runtime.fullscreenScalingQuality || include_aspect ? this.runtime.aspect_scale : 1);
	};
	
	Layer.prototype.getNormalScale = function ()
	{
		return ((this.scale * this.layout.scale) - 1) * this.zoomRate + 1;
	};
	
	Layer.prototype.getAngle = function ()
	{
		if (this.disableAngle)
			return 0;
			
		return cr.clamp_angle(this.layout.angle + this.angle);
	};
	
	var arr_cache = [];

	function alloc_arr()
	{
		if (arr_cache.length)
			return arr_cache.pop();
		else
			return [];
	}

	function free_arr(a)
	{
		cr.clearArray(a);
		arr_cache.push(a);
	};
	
	function mergeSortedZArrays(a, b, out)
	{
		var i = 0, j = 0, k = 0, lena = a.length, lenb = b.length, ai, bj;
		out.length = lena + lenb;
		
		for ( ; i < lena && j < lenb; ++k)
		{
			ai = a[i];
			bj = b[j];
			
			if (ai.zindex < bj.zindex)
			{
				out[k] = ai;
				++i;
			}
			else
			{
				out[k] = bj;
				++j;
			}
		}
		
		// Finish last run of either array if not done yet
		for ( ; i < lena; ++i, ++k)
			out[k] = a[i];
		
		for ( ; j < lenb; ++j, ++k)
			out[k] = b[j];
	};
	
	var next_arr = [];
	
	function mergeAllSortedZArrays_pass(arr, first_pass)
	{
		var i, len, arr1, arr2, out;
		
		for (i = 0, len = arr.length; i < len - 1; i += 2)
		{
			arr1 = arr[i];
			arr2 = arr[i+1];
			out = alloc_arr();
			mergeSortedZArrays(arr1, arr2, out);
			
			// On all but the first pass, the arrays in arr are locally allocated
			// and can be recycled.
			if (!first_pass)
			{
				free_arr(arr1);
				free_arr(arr2);
			}
			
			next_arr.push(out);
		}
		
		// if odd number of items then last one wasn't collapsed - append in to result again
		if (len % 2 === 1)
		{
			// The first pass uses direct reference to render cell arrays, so we can't just
			// pass through the odd array - it must be allocated and copied so it's recyclable.
			if (first_pass)
			{
				arr1 = alloc_arr();
				cr.shallowAssignArray(arr1, arr[len - 1]);
				next_arr.push(arr1);
			}
			else
			{
				next_arr.push(arr[len - 1]);
			}
		}
		
		cr.shallowAssignArray(arr, next_arr);
		cr.clearArray(next_arr);
	};

	function mergeAllSortedZArrays(arr)
	{
		var first_pass = true;
		
		while (arr.length > 1)
		{
			mergeAllSortedZArrays_pass(arr, first_pass);
			first_pass = false;
		}
		
		return arr[0];
	};
	
	var render_arr = [];
	
	Layer.prototype.getRenderCellInstancesToDraw = function ()
	{
		assert2(this.useRenderCells, "Cannot call getRenderCellInstancesToDraw when not using render cells");
		
		// Ensure all Z indices up-to-date for sorting.
		this.updateZIndices();
		
		// Now render cells are up to date, collect all the sorted instance lists from the render cells
		// inside the viewport to an array of arrays to merge.
		this.render_grid.queryRange(this.viewLeft, this.viewTop, this.viewRight, this.viewBottom, render_arr);
		
		// If there were no render cells returned at all, return a dummy empty array, otherwise the below
		// sort returns undefined.
		if (!render_arr.length)
			return alloc_arr();
		
		// If there is just one list returned, it will be holding a direct reference to the render cell's contents.
		// The caller will try to free this array. So make sure it gets copied to an allocated array that
		// can be freed.
		if (render_arr.length === 1)
		{
			var a = alloc_arr();
			cr.shallowAssignArray(a, render_arr[0]);
			cr.clearArray(render_arr);
			return a;
		}
		
		// render_arr.length is >= 2. Merge the result in to a single Z-sorted list.
		var draw_list = mergeAllSortedZArrays(render_arr);
		
		// Caller recycles returned draw_list.
		cr.clearArray(render_arr);
		
		return draw_list;
	};

	Layer.prototype.draw = function (ctx)
	{
		// Needs own texture
		this.render_offscreen = (this.forceOwnTexture || this.opacity !== 1.0 || this.blend_mode !== 0);
		var layer_canvas = this.runtime.canvas;
		var layer_ctx = ctx;
		var ctx_changed = false;

		if (this.render_offscreen)
		{
			// Need another canvas to render to.  Ensure it is created.
			if (!this.runtime.layer_canvas)
			{
				this.runtime.layer_canvas = document.createElement("canvas");
				assert2(this.runtime.layer_canvas, "Could not create layer canvas - render-to-texture won't work!");
				layer_canvas = this.runtime.layer_canvas;
				layer_canvas.width = this.runtime.draw_width;
				layer_canvas.height = this.runtime.draw_height;
				this.runtime.layer_ctx = layer_canvas.getContext("2d");
				assert2(this.runtime.layer_ctx, "Could not get layer 2D context - render-to-texture won't work!");
				ctx_changed = true;
			}

			layer_canvas = this.runtime.layer_canvas;
			layer_ctx = this.runtime.layer_ctx;

			// Window size has changed (browser fullscreen mode)
			if (layer_canvas.width !== this.runtime.draw_width)
			{
				layer_canvas.width = this.runtime.draw_width;
				ctx_changed = true;
			}
			if (layer_canvas.height !== this.runtime.draw_height)
			{
				layer_canvas.height = this.runtime.draw_height;
				ctx_changed = true;
			}
			
			if (ctx_changed)
			{
				layer_ctx.imageSmoothingEnabled = this.runtime.linearSampling;
			}

			// If transparent, there's no fillRect to clear it - so clear it transparent now
			if (this.transparent)
				layer_ctx.clearRect(0, 0, this.runtime.draw_width, this.runtime.draw_height);
		}
		
		layer_ctx.globalAlpha = 1;
		layer_ctx.globalCompositeOperation = "source-over";
		
		// Not transparent: fill with background
		if (!this.transparent)
		{
			layer_ctx.fillStyle = "rgb(" + this.background_color[0] + "," + this.background_color[1] + "," + this.background_color[2] + ")";
			layer_ctx.fillRect(0, 0, this.runtime.draw_width, this.runtime.draw_height);
		}

		layer_ctx.save();

		// Calculate the top-left point of the currently scrolled and scaled view (but not rotated)
		this.disableAngle = true;
		var px = this.canvasToLayer(0, 0, true, true);
		var py = this.canvasToLayer(0, 0, false, true);
		this.disableAngle = false;
		
		if (this.runtime.pixel_rounding)
		{
			px = Math.round(px);
			py = Math.round(py);
		}
		
		this.rotateViewport(px, py, layer_ctx);
		
		// Scroll the layer to the new top-left point and also scale
		var myscale = this.getScale();
		layer_ctx.scale(myscale, myscale);
		layer_ctx.translate(-px, -py);

		// Get instances to render. In render cells mode, this will be derived from the on-screen cells,
		// otherwise it just returns this.instances. If possible in render cells mode re-use the last
		// display list.
		var instances_to_draw;
		
		if (this.useRenderCells)
		{
			this.cur_render_cells.left = this.render_grid.XToCell(this.viewLeft);
			this.cur_render_cells.top = this.render_grid.YToCell(this.viewTop);
			this.cur_render_cells.right = this.render_grid.XToCell(this.viewRight);
			this.cur_render_cells.bottom = this.render_grid.YToCell(this.viewBottom);
			
			if (this.render_list_stale || !this.cur_render_cells.equals(this.last_render_cells))
			{
				free_arr(this.last_render_list);
				instances_to_draw = this.getRenderCellInstancesToDraw();
				this.render_list_stale = false;
				this.last_render_cells.copy(this.cur_render_cells);
			}
			else
				instances_to_draw = this.last_render_list;
		}
		else
			instances_to_draw = this.instances;
		
		var i, len, inst, last_inst = null;
		
		for (i = 0, len = instances_to_draw.length; i < len; ++i)
		{
			inst = instances_to_draw[i];
			
			// Render cells are allowed to return a sorted list with duplicates. In this case the same instance
			// may appear multiple times consecutively. To avoid multiple draws, skip consecutive entries.
			if (inst === last_inst)
				continue;
			
			this.drawInstance(inst, layer_ctx);
			last_inst = inst;
		}
		
		// If used render cells, instances_to_draw is temporary and should be recycled
		if (this.useRenderCells)
			this.last_render_list = instances_to_draw;

		layer_ctx.restore();

		// If rendered to texture, paste to main display now
		if (this.render_offscreen)
		{
			// Drawing at layer opacity with layer blend mode
			ctx.globalCompositeOperation = this.compositeOp;
			ctx.globalAlpha = this.opacity;

			ctx.drawImage(layer_canvas, 0, 0);
		}
	};
	
	Layer.prototype.drawInstance = function(inst, layer_ctx)
	{
		// Skip if invisible or zero sized
		if (!inst.visible || inst.width === 0 || inst.height === 0)
			return;

		// Skip if not in the viewable area
		inst.update_bbox();
		var bbox = inst.bbox;
		
		if (bbox.right < this.viewLeft || bbox.bottom < this.viewTop || bbox.left > this.viewRight || bbox.top > this.viewBottom)
			return;

		// Draw the instance
		layer_ctx.globalCompositeOperation = inst.compositeOp;
		inst.draw(layer_ctx);
	};
	
	Layer.prototype.updateViewport = function (ctx)
	{
		this.disableAngle = true;
		var px = this.canvasToLayer(0, 0, true, true);
		var py = this.canvasToLayer(0, 0, false, true);
		this.disableAngle = false;
		
		if (this.runtime.pixel_rounding)
		{
			px = Math.round(px);
			py = Math.round(py);
		}
		
		this.rotateViewport(px, py, ctx);
	};
	
	Layer.prototype.rotateViewport = function (px, py, ctx)
	{
		var myscale = this.getScale();
		
		this.viewLeft = px;
		this.viewTop = py;
		this.viewRight = px + (this.runtime.draw_width * (1 / myscale));
		this.viewBottom = py + (this.runtime.draw_height * (1 / myscale));
		
		var myAngle = this.getAngle();
		
		if (myAngle !== 0)
		{
			if (ctx)
			{
				ctx.translate(this.runtime.draw_width / 2, this.runtime.draw_height / 2);
				ctx.rotate(-myAngle);
				ctx.translate(this.runtime.draw_width / -2, this.runtime.draw_height / -2);
			}
			
			// adjust viewport bounds
			this.tmprect.set(this.viewLeft, this.viewTop, this.viewRight, this.viewBottom);
			this.tmprect.offset((this.viewLeft + this.viewRight) / -2, (this.viewTop + this.viewBottom) / -2);
			this.tmpquad.set_from_rotated_rect(this.tmprect, myAngle);
			this.tmpquad.bounding_box(this.tmprect);
			this.tmprect.offset((this.viewLeft + this.viewRight) / 2, (this.viewTop + this.viewBottom) / 2);
			this.viewLeft = this.tmprect.left;
			this.viewTop = this.tmprect.top;
			this.viewRight = this.tmprect.right;
			this.viewBottom = this.tmprect.bottom;
		}
	}
	
	Layer.prototype.drawGL_earlyZPass = function (glw)
	{
		var windowWidth = this.runtime.draw_width;
		var windowHeight = this.runtime.draw_height;
		var shaderindex = 0;
		var etindex = 0;
		
		// In early Z mode, this layer will only need its own texture in force own texture mode.
		// Early Z is skipped if the blend mode or opacity have changed, or if there are any effects.
		this.render_offscreen = this.forceOwnTexture;

		if (this.render_offscreen)
		{
			// Need another canvas to render to.  Ensure it is created.
			if (!this.runtime.layer_tex)
			{
				this.runtime.layer_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}

			// Window size has changed (browser fullscreen mode)
			if (this.runtime.layer_tex.c2width !== this.runtime.draw_width || this.runtime.layer_tex.c2height !== this.runtime.draw_height)
			{
				glw.deleteTexture(this.runtime.layer_tex);
				this.runtime.layer_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}
			
			glw.setRenderingToTexture(this.runtime.layer_tex);
		}

		// Calculate the top-left point of the currently scrolled and scaled view (but not rotated)
		this.disableAngle = true;
		var px = this.canvasToLayer(0, 0, true, true);
		var py = this.canvasToLayer(0, 0, false, true);
		this.disableAngle = false;
		
		if (this.runtime.pixel_rounding)
		{
			px = Math.round(px);
			py = Math.round(py);
		}
		
		this.rotateViewport(px, py, null);
		
		// Scroll the layer to the new top-left point and also scale
		var myscale = this.getScale();
		glw.resetModelView();
		glw.scale(myscale, myscale);
		glw.rotateZ(-this.getAngle());
		glw.translate((this.viewLeft + this.viewRight) / -2, (this.viewTop + this.viewBottom) / -2);
		glw.updateModelView();

		// Get instances to render. In render cells mode, this will be derived from the on-screen cells,
		// otherwise it just returns this.instances. If possible in render cells mode re-use the last
		// display list.
		var instances_to_draw;
		
		if (this.useRenderCells)
		{
			this.cur_render_cells.left = this.render_grid.XToCell(this.viewLeft);
			this.cur_render_cells.top = this.render_grid.YToCell(this.viewTop);
			this.cur_render_cells.right = this.render_grid.XToCell(this.viewRight);
			this.cur_render_cells.bottom = this.render_grid.YToCell(this.viewBottom);
			
			if (this.render_list_stale || !this.cur_render_cells.equals(this.last_render_cells))
			{
				free_arr(this.last_render_list);
				instances_to_draw = this.getRenderCellInstancesToDraw();
				this.render_list_stale = false;
				this.last_render_cells.copy(this.cur_render_cells);
			}
			else
				instances_to_draw = this.last_render_list;
		}
		else
			instances_to_draw = this.instances;
		
		// Render instances in front-to-back order
		var i, inst, last_inst = null;
		
		for (i = instances_to_draw.length - 1; i >= 0; --i)
		{
			inst = instances_to_draw[i];
			
			// Render cells are allowed to return a sorted list with duplicates. In this case the same instance
			// may appear multiple times consecutively. To avoid multiple draws, skip consecutive entries.
			if (inst === last_inst)
				continue;
			
			this.drawInstanceGL_earlyZPass(instances_to_draw[i], glw);
			last_inst = inst;
		}
		
		// If used render cells, cache the last display list in case it can be re-used again
		if (this.useRenderCells)
			this.last_render_list = instances_to_draw;
		
		// Not transparent: fill with background
		if (!this.transparent)
		{
			this.clear_earlyz_index = this.runtime.earlyz_index++;
			glw.setEarlyZIndex(this.clear_earlyz_index);
			
			// fill color does not matter, simply exists to fill depth buffer
			glw.setColorFillMode(1, 1, 1, 1);
			glw.fullscreenQuad();		// fill remaining space in depth buffer with current Z value
			glw.restoreEarlyZMode();
		}
	};
	
	Layer.prototype.drawGL = function (glw)
	{
		var windowWidth = this.runtime.draw_width;
		var windowHeight = this.runtime.draw_height;
		var shaderindex = 0;
		var etindex = 0;
		
		// Needs own texture
		this.render_offscreen = (this.forceOwnTexture || this.opacity !== 1.0 || this.active_effect_types.length > 0 || this.blend_mode !== 0);

		if (this.render_offscreen)
		{
			// Need another canvas to render to.  Ensure it is created.
			if (!this.runtime.layer_tex)
			{
				this.runtime.layer_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}

			// Window size has changed (browser fullscreen mode)
			if (this.runtime.layer_tex.c2width !== this.runtime.draw_width || this.runtime.layer_tex.c2height !== this.runtime.draw_height)
			{
				glw.deleteTexture(this.runtime.layer_tex);
				this.runtime.layer_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}
			
			glw.setRenderingToTexture(this.runtime.layer_tex);

			// If transparent, there's no fillRect to clear it - so clear it transparent now
			if (this.transparent)
				glw.clear(0, 0, 0, 0);
		}
		
		// Not transparent: fill with background
		if (!this.transparent)
		{
			if (this.runtime.enableFrontToBack)
			{
				// front-to-back rendering: use fullscreen quad to take advantage of depth buffer
				glw.setEarlyZIndex(this.clear_earlyz_index);
			
				glw.setColorFillMode(this.background_color[0] / 255, this.background_color[1] / 255, this.background_color[2] / 255, 1);
				glw.fullscreenQuad();
				glw.setTextureFillMode();
			}
			else
			{
				// back-to-front rendering: normal clear
				glw.clear(this.background_color[0] / 255, this.background_color[1] / 255, this.background_color[2] / 255, 1);
			}
		}

		// Calculate the top-left point of the currently scrolled and scaled view (but not rotated)
		this.disableAngle = true;
		var px = this.canvasToLayer(0, 0, true, true);
		var py = this.canvasToLayer(0, 0, false, true);
		this.disableAngle = false;
		
		if (this.runtime.pixel_rounding)
		{
			px = Math.round(px);
			py = Math.round(py);
		}
		
		this.rotateViewport(px, py, null);
		
		// Scroll the layer to the new top-left point and also scale
		var myscale = this.getScale();
		glw.resetModelView();
		glw.scale(myscale, myscale);
		glw.rotateZ(-this.getAngle());
		glw.translate((this.viewLeft + this.viewRight) / -2, (this.viewTop + this.viewBottom) / -2);
		glw.updateModelView();

		// Get instances to render. In render cells mode, this will be derived from the on-screen cells,
		// otherwise it just returns this.instances. If possible in render cells mode re-use the last
		// display list.
		var instances_to_draw;
		
		if (this.useRenderCells)
		{
			this.cur_render_cells.left = this.render_grid.XToCell(this.viewLeft);
			this.cur_render_cells.top = this.render_grid.YToCell(this.viewTop);
			this.cur_render_cells.right = this.render_grid.XToCell(this.viewRight);
			this.cur_render_cells.bottom = this.render_grid.YToCell(this.viewBottom);
			
			if (this.render_list_stale || !this.cur_render_cells.equals(this.last_render_cells))
			{
				free_arr(this.last_render_list);
				instances_to_draw = this.getRenderCellInstancesToDraw();
				this.render_list_stale = false;
				this.last_render_cells.copy(this.cur_render_cells);
			}
			else
				instances_to_draw = this.last_render_list;
		}
		else
			instances_to_draw = this.instances;
		
		var i, len, inst, last_inst = null;
		
		for (i = 0, len = instances_to_draw.length; i < len; ++i)
		{
			inst = instances_to_draw[i];
			
			// Render cells are allowed to return a sorted list with duplicates. In this case the same instance
			// may appear multiple times consecutively. To avoid multiple draws, skip consecutive entries.
			if (inst === last_inst)
				continue;
			
			this.drawInstanceGL(instances_to_draw[i], glw);
			last_inst = inst;
		}
		
		// If used render cells, cache the last display list in case it can be re-used again
		if (this.useRenderCells)
			this.last_render_list = instances_to_draw;

		// If rendered to texture, paste to main display now
		if (this.render_offscreen)
		{
			// Note some of the single-shader rendering limitations also apply to layers
			//if (inst.type.effect_types.length === 1 && !glw.programUsesCrossSampling(shaderindex) &&
			//		!glw.programExtendsBox(shaderindex) && (!inst.angle || !glw.programUsesDest(shaderindex)) &&
			//		inst.opacity === 1)
			shaderindex = this.active_effect_types.length ? this.active_effect_types[0].shaderindex : 0;
			etindex = this.active_effect_types.length ? this.active_effect_types[0].index : 0;
			
			if (this.active_effect_types.length === 0 || (this.active_effect_types.length === 1 &&
				!glw.programUsesCrossSampling(shaderindex) && this.opacity === 1))
			{				
				if (this.active_effect_types.length === 1)
				{
					glw.switchProgram(shaderindex);
					glw.setProgramParameters(this.layout.getRenderTarget(),		// backTex
											 1.0 / this.runtime.draw_width,		// pixelWidth
											 1.0 / this.runtime.draw_height,	// pixelHeight
											 0.0, 0.0,							// srcStart
											 1.0, 1.0,							// srcEnd
											 0.0, 0.0,							// srcOriginStart
											 1.0, 1.0,							// srcOriginEnd
											 this.viewLeft, this.viewTop,		// layoutStart
											 this.viewRight, this.viewBottom,	// layoutEnd
											 0.0, 0.0,							// destStart
											 1.0, 1.0,							// destEnd
											 myscale,							// layerScale
											 this.getAngle(),
											 this.runtime.kahanTime.sum,
											 this.effect_params[etindex]);		// fx parameters
											 
					if (glw.programIsAnimated(shaderindex))
						this.runtime.redraw = true;
				}
				else
					glw.switchProgram(0);
					
				glw.setRenderingToTexture(this.layout.getRenderTarget());
				glw.setOpacity(this.opacity);
				glw.setTexture(this.runtime.layer_tex);
				glw.setBlend(this.srcBlend, this.destBlend);
				glw.resetModelView();
				glw.updateModelView();
				var halfw = this.runtime.draw_width / 2;
				var halfh = this.runtime.draw_height / 2;
				glw.quad(-halfw, halfh, halfw, halfh, halfw, -halfh, -halfw, -halfh);
				glw.setTexture(null);
			}
			else
			{
				this.layout.renderEffectChain(glw, this, null, this.layout.getRenderTarget());
			}
		}
	};
	
	Layer.prototype.drawInstanceGL = function (inst, glw)
	{
		assert2(inst.layer === this, "Drawing instance on wrong layer");
		
		// Skip if invisible or zero sized
		if (!inst.visible || inst.width === 0 || inst.height === 0)
			return;

		// Skip if not in the viewable area
		inst.update_bbox();
		var bbox = inst.bbox;
		
		if (bbox.right < this.viewLeft || bbox.bottom < this.viewTop || bbox.left > this.viewRight || bbox.top > this.viewBottom)
			return;

		glw.setEarlyZIndex(inst.earlyz_index);
		
		// Draw using shaders
		if (inst.uses_shaders)
		{
			this.drawInstanceWithShadersGL(inst, glw);
		}
		// Draw normally without any special shaders
		else
		{
			glw.switchProgram(0);		// un-set any previously set shader
			glw.setBlend(inst.srcBlend, inst.destBlend);
			inst.drawGL(glw);
		}
	};
	
	Layer.prototype.drawInstanceGL_earlyZPass = function (inst, glw)
	{
		assert2(inst.layer === this, "Drawing instance on wrong layer");
		
		// As per normal rendering, skip if invisible or zero sized
		if (!inst.visible || inst.width === 0 || inst.height === 0)
			return;

		// As per normal rendering, skip if not in the viewable area
		inst.update_bbox();
		var bbox = inst.bbox;
		
		if (bbox.right < this.viewLeft || bbox.bottom < this.viewTop || bbox.left > this.viewRight || bbox.top > this.viewBottom)
			return;
		
		// Write the distance-increasing early Z index to the instance to reuse later.
		// Note this is done after the same checks as normal rendering, so we only Z index the objects that are
		// actually going to have draw calls made. Later when the real draw call is made, its Z position is based
		// off this value.
		inst.earlyz_index = this.runtime.earlyz_index++;
		
		// Don't actually make an early Z pass if the object does not preserve opaqueness, or if
		// it doesn't support the drawGL_earlyZPass method.
		if (inst.blend_mode !== 0 || inst.opacity !== 1 || !inst.shaders_preserve_opaqueness || !inst.drawGL_earlyZPass)
			return;
		
		glw.setEarlyZIndex(inst.earlyz_index);
		inst.drawGL_earlyZPass(glw);
	};
	
	Layer.prototype.drawInstanceWithShadersGL = function (inst, glw)
	{
		// Where possible, draw an instance using a single shader direct to display for
		// maximum efficiency.  This can only be done if:
		// 1) The shader does not use cross-sampling.  If it does it has to render to an intermediate
		//    texture to prevent glitching, which is done via renderEffectChain.
		// 2) The shader does not use background blending, or the object is not rotated (at 0 degrees).
		//    Since the background is sampled linearly as a bounding box, it only works when the object
		//    is not rotated, otherwise the background gets rotated as well.  To fix this rotated objects
		//	  are pre-drawn to an offscreen surface in renderEffectChain.
		// 3) The shader does not extend the bounding box.  In this case as per 2) it also needs
		//    pre-drawing to an offscreen surface for the bounds to be enlarged.
		// 4) The object has 100% opacity.  If it has a different opacity, the opacity must be processed
		//    by pre-drawing.
		// Consider a screen blend for an unrotated object at 100% opacity on a mobile device.  While the
		// restrictions are fairly complicated, this allows the device to simply switch program, set
		// parameters and render without having to do any of the GPU-intensive swapping done in renderEffectChain.
		var shaderindex = inst.active_effect_types[0].shaderindex;
		var etindex = inst.active_effect_types[0].index;
		var myscale = this.getScale();
		
		if (inst.active_effect_types.length === 1 && !glw.programUsesCrossSampling(shaderindex) &&
			!glw.programExtendsBox(shaderindex) && ((!inst.angle && !inst.layer.getAngle()) || !glw.programUsesDest(shaderindex)) &&
			inst.opacity === 1 && !inst.type.plugin.must_predraw)
		{
			// Set the shader program to use
			glw.switchProgram(shaderindex);
			glw.setBlend(inst.srcBlend, inst.destBlend);
			
			if (glw.programIsAnimated(shaderindex))
				this.runtime.redraw = true;
			
			var destStartX = 0, destStartY = 0, destEndX = 0, destEndY = 0;
			
			// Skip screen co-ord calculations if shader doesn't use them
			if (glw.programUsesDest(shaderindex))
			{
				// Set the shader parameters
				var bbox = inst.bbox;
				var screenleft = this.layerToCanvas(bbox.left, bbox.top, true, true);
				var screentop = this.layerToCanvas(bbox.left, bbox.top, false, true);
				var screenright = this.layerToCanvas(bbox.right, bbox.bottom, true, true);
				var screenbottom = this.layerToCanvas(bbox.right, bbox.bottom, false, true);
				
				destStartX = screenleft / windowWidth;
				destStartY = 1 - screentop / windowHeight;
				destEndX = screenright / windowWidth;
				destEndY = 1 - screenbottom / windowHeight;
			}
			
			var srcStartX = 0, srcStartY = 0, srcEndX = 1, srcEndY = 1;
			var pxWidth = 1 / inst.width;
			var pxHeight = 1 / inst.height;
				
			// HACK for Sprite plugin: if we can find spritesheet co-ordinates for this instance, use them as the source rectangle.
			if (inst.curFrame && inst.curFrame.sheetTex)
			{
				srcStartX = inst.curFrame.sheetTex.left;
				srcStartY = inst.curFrame.sheetTex.top;
				srcEndX = inst.curFrame.sheetTex.right;
				srcEndY = inst.curFrame.sheetTex.bottom;
				
				if (inst.curFrame.texture_img)
				{
					pxWidth = 1 / inst.curFrame.texture_img.width;
					pxHeight = 1 / inst.curFrame.texture_img.height;
				}
			}
	
			glw.setProgramParameters(this.render_offscreen ? this.runtime.layer_tex : this.layout.getRenderTarget(), // backTex
									 pxWidth,							// pixelWidth
									 pxHeight,							// pixelHeight
									 srcStartX, srcStartY,				// srcStart
									 srcEndX, srcEndY,					// srcEnd
									 srcStartX, srcStartY,				// srcOriginStart
									 srcEndX, srcEndY,					// srcOriginEnd
									 inst.bbox.left, inst.bbox.top,		// layoutStart
									 inst.bbox.right, inst.bbox.bottom,	// layoutEnd
									 destStartX, destStartY,
									 destEndX, destEndY,
									 myscale,
									 this.getAngle(),
									 this.runtime.kahanTime.sum,
									 inst.effect_params[etindex]);
			
			// Draw instance
			inst.drawGL(glw);
		}
		// Draw using offscreen surfaces
		else
		{
			this.layout.renderEffectChain(glw, this, inst, this.render_offscreen ? this.runtime.layer_tex : this.layout.getRenderTarget());
			
			// Reset model view
			glw.resetModelView();
			glw.scale(myscale, myscale);
			glw.rotateZ(-this.getAngle());
			glw.translate((this.viewLeft + this.viewRight) / -2, (this.viewTop + this.viewBottom) / -2);
			glw.updateModelView();
		}
	};
	
	// Translate point in canvas coords to layer coords
	Layer.prototype.canvasToLayer = function (ptx, pty, getx, using_draw_area)
	{
		// Take in to account retina displays which map css to canvas pixels differently
		var multiplier = this.runtime.devicePixelRatio;
		
		if (this.runtime.isRetina)
		{
			ptx *= multiplier;
			pty *= multiplier;
		}
		
		// Apply parallax
		var ox = this.runtime.parallax_x_origin;
		var oy = this.runtime.parallax_y_origin;
		var par_x = ((this.layout.scrollX - ox) * this.parallaxX) + ox;
		var par_y = ((this.layout.scrollY - oy) * this.parallaxY) + oy;
		var x = par_x;
		var y = par_y;
		
		// Move to top-left of visible area
		var invScale = 1 / this.getScale(!using_draw_area);
		
		if (using_draw_area)
		{
			x -= (this.runtime.draw_width * invScale) / 2;
			y -= (this.runtime.draw_height * invScale) / 2;
		}
		else
		{
			x -= (this.runtime.width * invScale) / 2;
			y -= (this.runtime.height * invScale) / 2;
		}
		
		x += ptx * invScale;
		y += pty * invScale;
		
		// Rotate about scroll center
		var a = this.getAngle();
		if (a !== 0)
		{
			x -= par_x;
			y -= par_y;
			var cosa = Math.cos(a);
			var sina = Math.sin(a);
			var x_temp = (x * cosa) - (y * sina);
			y = (y * cosa) + (x * sina);
			x = x_temp;
			x += par_x;
			y += par_y;
		}
		
		// Return point in layer coords
		return getx ? x : y;
	};
	
	// If ignore_aspect is passed, converts layer to draw area instead
	Layer.prototype.layerToCanvas = function (ptx, pty, getx, using_draw_area)
	{
		var ox = this.runtime.parallax_x_origin;
		var oy = this.runtime.parallax_y_origin;
		var par_x = ((this.layout.scrollX - ox) * this.parallaxX) + ox;
		var par_y = ((this.layout.scrollY - oy) * this.parallaxY) + oy;
		var x = par_x;
		var y = par_y;
		
		// Rotate about canvas center
		var a = this.getAngle();
		
		if (a !== 0)
		{
			ptx -= par_x;
			pty -= par_y;
			var cosa = Math.cos(-a);
			var sina = Math.sin(-a);
			var x_temp = (ptx * cosa) - (pty * sina);
			pty = (pty * cosa) + (ptx * sina);
			ptx = x_temp;
			ptx += par_x;
			pty += par_y;
		}
		
		var invScale = 1 / this.getScale(!using_draw_area);
		
		if (using_draw_area)
		{
			x -= (this.runtime.draw_width * invScale) / 2;
			y -= (this.runtime.draw_height * invScale) / 2;
		}
		else
		{
			x -= (this.runtime.width * invScale) / 2;
			y -= (this.runtime.height * invScale) / 2;
		}
		
		x = (ptx - x) / invScale;
		y = (pty - y) / invScale;
	
		// Take in to account retina displays which map css to canvas pixels differently
		var multiplier = this.runtime.devicePixelRatio;
		
		if (this.runtime.isRetina && !using_draw_area)
		{
			x /= multiplier;
			y /= multiplier;
		}
		
		return getx ? x : y;
	};
	
	Layer.prototype.rotatePt = function (x_, y_, getx)
	{
		if (this.getAngle() === 0)
			return getx ? x_ : y_;
		
		var nx = this.layerToCanvas(x_, y_, true);
		var ny = this.layerToCanvas(x_, y_, false);
		
		this.disableAngle = true;
		var px = this.canvasToLayer(nx, ny, true);
		var py = this.canvasToLayer(nx, ny, true);
		this.disableAngle = false;
		
		return getx ? px : py;
	};
	
	Layer.prototype.saveToJSON = function ()
	{
		var i, len, et;
		
		var o = {
			"s": this.scale,
			"a": this.angle,
			"vl": this.viewLeft,
			"vt": this.viewTop,
			"vr": this.viewRight,
			"vb": this.viewBottom,
			"v": this.visible,
			"bc": this.background_color,
			"t": this.transparent,
			"px": this.parallaxX,
			"py": this.parallaxY,
			"o": this.opacity,
			"zr": this.zoomRate,
			"fx": [],
			"cg": this.created_globals,		// added r197; list of global UIDs already created
			"instances": []
		};
		
		for (i = 0, len = this.effect_types.length; i < len; i++)
		{
			et = this.effect_types[i];
			o["fx"].push({"name": et.name, "active": et.active, "params": this.effect_params[et.index] });
		}
		
		return o;
	};
	
	Layer.prototype.loadFromJSON = function (o)
	{
		var i, j, len, p, inst, fx;
		
		this.scale = o["s"];
		this.angle = o["a"];
		this.viewLeft = o["vl"];
		this.viewTop = o["vt"];
		this.viewRight = o["vr"];
		this.viewBottom = o["vb"];
		this.visible = o["v"];
		this.background_color = o["bc"];
		this.transparent = o["t"];
		this.parallaxX = o["px"];
		this.parallaxY = o["py"];
		this.opacity = o["o"];
		this.zoomRate = o["zr"];
		this.created_globals = o["cg"] || [];		// added r197
		
		// If we are loading a state that has already created global objects, they need to be removed
		// from initial_instances again. Restore all the original initial instances (startup_initial_instances) 
		// then run through the initial_instances list and remove any instances that have a UID in the created_globals list.
		cr.shallowAssignArray(this.initial_instances, this.startup_initial_instances);
		
		var temp_set = new cr.ObjectSet();
		for (i = 0, len = this.created_globals.length; i < len; ++i)
			temp_set.add(this.created_globals[i]);
		
		for (i = 0, j = 0, len = this.initial_instances.length; i < len; ++i)
		{
			if (!temp_set.contains(this.initial_instances[i][2]))		// UID in element 2
			{
				this.initial_instances[j] = this.initial_instances[i];
				++j;
			}
		}
		
		cr.truncateArray(this.initial_instances, j);
		
		// Load active effects and effect parameters
		var ofx = o["fx"];
		
		for (i = 0, len = ofx.length; i < len; i++)
		{
			fx = this.getEffectByName(ofx[i]["name"]);
			
			if (!fx)
				continue;		// must've gone missing
				
			fx.active = ofx[i]["active"];
			this.effect_params[fx.index] = ofx[i]["params"];
		}
		
		this.updateActiveEffects();
		
		// Load instances.
		// Before this step, all instances were created on the correct layers. So we have the right
		// instances on this layer, but they need to be updated so their Z order is correct given their
		// zindex properties that were loaded. So sort the instances list now.
		this.instances.sort(sort_by_zindex);
		
		// There could be duplicate or missing Z indices, so re-index all the Z indices again anyway.
		this.zindices_stale = true;
	};
	
	cr.layer = Layer;
}());

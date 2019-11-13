// ECMAScript 5 strict mode
"use strict";

assert2(cr, "cr namespace not created");

(function()
{
	// Layout class
	function Layout(runtime, m)
	{
		// Runtime members
		this.runtime = runtime;
		this.event_sheet = null;
		this.scrollX = (this.runtime.original_width / 2);
		this.scrollY = (this.runtime.original_height / 2);
		this.scale = 1.0;
		this.angle = 0;
		this.first_visit = true;
		
		// Data model values
		this.name = m[0];
		this.originalWidth = m[1];
		this.originalHeight = m[2];
		this.width = m[1];
		this.height = m[2];
		this.unbounded_scrolling = m[3];
		this.sheetname = m[4];
		this.sid = m[5];
		
		// Create layers from layers model
		var lm = m[6];
		var i, len;
		this.layers = [];
		this.initial_types = [];
		
		for (i = 0, len = lm.length; i < len; i++)
		{
			// Create real layer
			var layer = new cr.layer(this, lm[i]);
			layer.number = i;
			cr.seal(layer);
			this.layers.push(layer);
		}
		
		// Initialise nonworld instances from model
		var im = m[7];
		this.initial_nonworld = [];
		
		for (i = 0, len = im.length; i < len; i++)
		{
			var inst = im[i];

			// Lookup type index
			var type = this.runtime.types_by_index[inst[1]];
			assert2(type, "Could not find nonworld object type: " + inst.type_name);

			// If type has no default instance, make it this one
			if (!type.default_instance)
				type.default_instance = inst;
				
			this.initial_nonworld.push(inst);
			
			if (this.initial_types.indexOf(type) === -1)
				this.initial_types.push(type);
		}
		
		// Assign shaders
		this.effect_types = [];
		this.active_effect_types = [];
		this.shaders_preserve_opaqueness = true;
		this.effect_params = [];
		
		for (i = 0, len = m[8].length; i < len; i++)
		{
			this.effect_types.push({
				id: m[8][i][0],
				name: m[8][i][1],
				shaderindex: -1,
				preservesOpaqueness: false,
				active: true,
				index: i
			});
			
			this.effect_params.push(m[8][i][2].slice(0));
		}
		
		this.updateActiveEffects();
		
		this.rcTexBounce = new cr.rect(0, 0, 1, 1);
		this.rcTexDest = new cr.rect(0, 0, 1, 1);
		this.rcTexOrigin = new cr.rect(0, 0, 1, 1);
		
		// Viewport of layout, calculated as a layer with default settings. Used for effect parameters.
		this.viewRect = new cr.rect(0, 0, 0, 0);
		
		// For persist behavior: {"type_sid": [inst, inst, inst...] }
		this.persist_data = {};
	};
	
	Layout.prototype.saveObjectToPersist = function (inst)
	{
		var sidStr = inst.type.sid.toString();
		
		if (!this.persist_data.hasOwnProperty(sidStr))
			this.persist_data[sidStr] = [];
			
		var type_persist = this.persist_data[sidStr];		
		type_persist.push(this.runtime.saveInstanceToJSON(inst));
	};
	
	Layout.prototype.hasOpaqueBottomLayer = function ()
	{
		var layer = this.layers[0];
		return !layer.transparent && layer.opacity === 1.0 && !layer.forceOwnTexture && layer.visible;
	};
	
	Layout.prototype.updateActiveEffects = function ()
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
	
	Layout.prototype.getEffectByName = function (name_)
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
	
	var created_instances = [];
	
	function sort_by_zindex(a, b)
	{
		return a.zindex - b.zindex;
	};
	
	var first_layout = true;

	Layout.prototype.startRunning = function ()
	{
		// Find event sheet
		if (this.sheetname)
		{
			this.event_sheet = this.runtime.eventsheets[this.sheetname];
			assert2(this.event_sheet, "Cannot find event sheet: " + this.sheetname);
			
			this.event_sheet.updateDeepIncludes();
		}

		// Mark this layout as running
		this.runtime.running_layout = this;
		
		// Restore the original layout size, since the savegame system may have changed it
		this.width = this.originalWidth;
		this.height = this.originalHeight;

		// Scroll to top left
		this.scrollX = (this.runtime.original_width / 2);
		this.scrollY = (this.runtime.original_height / 2);
		
		// Shift all leftover global objects with a layer to this layout's layers instead
		var i, k, len, lenk, type, type_instances, initial_inst, inst, iid, t, s, p, q, type_data, layer;
		
		for (i = 0, len = this.runtime.types_by_index.length; i < len; i++)
		{
			type = this.runtime.types_by_index[i];
			
			if (type.is_family)
				continue;		// instances are only transferred for their real type
			
			type_instances = type.instances;
			
			for (k = 0, lenk = type_instances.length; k < lenk; k++)
			{
				inst = type_instances[k];
				
				if (inst.layer)
				{
					var num = inst.layer.number;
					if (num >= this.layers.length)
						num = this.layers.length - 1;
					inst.layer = this.layers[num];
					
					// Instances created when destroying objects from leaving the last layout
					// may still reside in the layer instance list. Be sure not to add twice.
					if (inst.layer.instances.indexOf(inst) === -1)
						inst.layer.instances.push(inst);
					
					inst.layer.zindices_stale = true;
				}
			}
		}
		
		// All the transferred global instances are now in whatever order they sit in their
		// instance lists, which could be jumbled up compared to their previous Z index.
		// Sort every layer's instances by their old Z indices to make an effort to preserve
		// global object's relative Z orders between layouts.
		// Don't do this on the very first layout run though, only when coming from another layout.
		if (!first_layout)
		{
			for (i = 0, len = this.layers.length; i < len; ++i)
			{
				this.layers[i].instances.sort(sort_by_zindex);
			}
		}
		
		var layer;
		cr.clearArray(created_instances);
		
		this.boundScrolling();

		// Create all the initial instances on layers
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			layer = this.layers[i];
			layer.createInitialInstances(created_instances);		// fills created_instances
			
			// Also reset layer view area (will not be set until next draw(), but it's better
			// than leaving it where it was from the last layout, which could be a different place)
			// Calculate the starting position, since otherwise 'Is on screen' is false for first tick
			// even for objects which are initially visible
			layer.updateViewport(null);
		}
		
		var uids_changed = false;
		
		// On second run and after, create persisted objects that were saved
		if (!this.first_visit)
		{
			for (p in this.persist_data)
			{
				if (this.persist_data.hasOwnProperty(p))
				{
					type = this.runtime.getObjectTypeBySid(parseInt(p, 10));
					
					if (!type || type.is_family || !this.runtime.typeHasPersistBehavior(type))
						continue;
					
					type_data = this.persist_data[p];
					
					for (i = 0, len = type_data.length; i < len; i++)
					{
						layer = null;
					
						if (type.plugin.is_world)
						{
							layer = this.getLayerBySid(type_data[i]["w"]["l"]);
							
							// layer's gone missing - just skip creating this instance
							if (!layer)
								continue;
						}
						
						// create an instance then load the state in to it
						// skip creating siblings; we'll link them up later
						inst = this.runtime.createInstanceFromInit(type.default_instance, layer, false, 0, 0, true);
						this.runtime.loadInstanceFromJSON(inst, type_data[i]);
						
						// createInstanceFromInit may have assigned a different UID to the one
						// loaded by loadInstanceFromJSON, so the runtime UID map may be wrong.
						// Make sure we rebuild the UID map from scratch in this case.
						uids_changed = true;
						
						created_instances.push(inst);
					}
					
					cr.clearArray(type_data);
				}
			}
			
			// Sort all layer indices to ensure Z order is restored
			for (i = 0, len = this.layers.length; i < len; i++)
			{
				this.layers[i].instances.sort(sort_by_zindex);
				this.layers[i].zindices_stale = true;		// in case of duplicates/holes
			}
		}
		
		if (uids_changed)
		{
			this.runtime.ClearDeathRow();
			this.runtime.refreshUidMap();
		}
		
		// createInstanceFromInit (via layer.createInitialInstance()s) does not create siblings for
		// containers when is_startup_instance is true, because all the instances are already in the layout.
		// Link them together now.
		for (i = 0; i < created_instances.length; i++)
		{
			inst = created_instances[i];
			
			if (!inst.type.is_contained)
				continue;
				
			iid = inst.get_iid();
				
			for (k = 0, lenk = inst.type.container.length; k < lenk; k++)
			{
				t = inst.type.container[k];
				
				if (inst.type === t)
					continue;
					
				if (t.instances.length > iid)
					inst.siblings.push(t.instances[iid]);
				else
				{
					// No initial paired instance in layout: create one
					if (!t.default_instance)
					{
						/**PREVIEWONLY**/ alert("Cannot create an instance of the object type '" + t.name + "': there are no instances of this object anywhere in the project.  Construct 3 needs at least one instance to know which properties to assign to the object.  To resolve this, add at least one instance of the object to the project, on an unused layout if necessary.");
					}
					else
					{
						s = this.runtime.createInstanceFromInit(t.default_instance, inst.layer, true, inst.x, inst.y, true);
						this.runtime.ClearDeathRow();
						t.updateIIDs();
						inst.siblings.push(s);
						created_instances.push(s);		// come back around and link up its own instances too
					}
				}
			}
		}
		
		// Create all initial non-world instances
		for (i = 0, len = this.initial_nonworld.length; i < len; i++)
		{
			initial_inst = this.initial_nonworld[i];
			type = this.runtime.types_by_index[initial_inst[1]];
			
			// If the type is in a container, don't create it; it should only be created along
			// with its container instances.
			if (!type.is_contained)
			{
				inst = this.runtime.createInstanceFromInit(this.initial_nonworld[i], null, true);
			}
			
			// Globals should not be in list; should have been created in createGlobalNonWorlds
			assert2(!inst.type.global, "Global non-world instance still in layout's initial non-world list");
		}		

		this.runtime.changelayout = null;
		
		// Create queued objects
		this.runtime.ClearDeathRow();
		
		// Canvas 2D renderer: attempt to preload all images that are used by types on this layout.
		// Since some canvas 2D browsers load images on demand, games can jank during playback as textures
		// are upload before first draw.  By drawing everything once on startup we can try to avoid this.
		// This may increase the chance devices run out of memory, but that's a problem with canvas 2D anyway.
		if (this.runtime.ctx)
		{
			for (i = 0, len = this.runtime.types_by_index.length; i < len; i++)
			{
				t = this.runtime.types_by_index[i];
				
				// Don't preload images for family types or when no instances used
				if (t.is_family || !t.instances.length || !t.preloadCanvas2D)
					continue;
					
				t.preloadCanvas2D(this.runtime.ctx);
			}
		}
		
		/*
		// Print VRAM
		if (this.runtime.glwrap)
		{
			console.log("Estimated VRAM at layout start: " + this.runtime.glwrap.textureCount() + " textures, approx. " + Math.round(this.runtime.glwrap.estimateVRAM() / 1024) + " kb");
		}
		*/
		
		// Now every container object is created and linked, run through them all firing 'On created'.
		// Note if we are loading a savegame, this must be deferred until loading is complete.
		if (this.runtime.isLoadingState)
		{
			cr.shallowAssignArray(this.runtime.fireOnCreateAfterLoad, created_instances);
		}
		else
		{
			// Not loading: fire all "On Created" now
			for (i = 0, len = created_instances.length; i < len; i++)
			{
				inst = created_instances[i];
				this.runtime.trigger(Object.getPrototypeOf(inst.type.plugin).cnds.OnCreated, inst);
			}
		}
		
		// Clear array to drop references
		cr.clearArray(created_instances);
		
		// Trigger 'start of layout', unless we are changing layout because a savegame is loading
		if (!this.runtime.isLoadingState)
		{
			this.runtime.trigger(cr.system_object.prototype.cnds.OnLayoutStart, null);
		}
		
		// Mark persisted objects to be loaded instead of initial objects next time around
		this.first_visit = false;
	};
	
	Layout.prototype.createGlobalNonWorlds = function ()
	{
		var i, k, len, initial_inst, inst, type;
		
		// Create all initial global non-world instances
		for (i = 0, k = 0, len = this.initial_nonworld.length; i < len; i++)
		{
			initial_inst = this.initial_nonworld[i];
			type = this.runtime.types_by_index[initial_inst[1]];
			
			if (type.global)
			{
				// If the type is in a container, don't create it; it should only be created along
				// with its container instances.
				if (!type.is_contained)
				{
					inst = this.runtime.createInstanceFromInit(initial_inst, null, true);
				}
			}
			else
			{			
				// Remove globals from list
				this.initial_nonworld[k] = initial_inst;
				k++;
			}
		}
		
		cr.truncateArray(this.initial_nonworld, k);
	};

	Layout.prototype.stopRunning = function ()
	{
		assert2(this.runtime.running_layout == this, "Calling stopRunning() on a layout that is not running");
		
		/*
		// Print VRAM
		if (this.runtime.glwrap)
		{
			console.log("Estimated VRAM at layout end: " + this.runtime.glwrap.textureCount() + " textures, approx. " + Math.round(this.runtime.glwrap.estimateVRAM() / 1024) + " kb");
		}
		*/

		// Trigger 'end of layout'
		if (!this.runtime.isLoadingState)
		{
			this.runtime.trigger(cr.system_object.prototype.cnds.OnLayoutEnd, null);
		}
		
		this.runtime.isEndingLayout = true;
		
		// Clear all 'wait'-scheduled events
		cr.clearArray(this.runtime.system.waits);

		var i, leni, j, lenj;
		var layer_instances, inst, type;
		
		// Save any objects with the persist behavior. We have to do this before destroying non-global
		// objects in case objects are in a container and destroying an instance will destroy a
		// linked instance further up with the persist behavior before we get to it.
		// Also skip if the first_visit flag is set, since this is set by the "reset persistent objects"
		// system action and means we don't want to save this layout's state.
		if (!this.first_visit)
		{
			for (i = 0, leni = this.layers.length; i < leni; i++)
			{
				// ensure Z indices up to date so next layout can try to preserve relative
				// order of globals
				this.layers[i].updateZIndices();
				
				layer_instances = this.layers[i].instances;
				
				for (j = 0, lenj = layer_instances.length; j < lenj; j++)
				{
					inst = layer_instances[j];
					
					if (!inst.type.global)
					{
						if (this.runtime.typeHasPersistBehavior(inst.type))
							this.saveObjectToPersist(inst);
					}
				}
			}
		}
		
		// Destroy all non-globals
		for (i = 0, leni = this.layers.length; i < leni; i++)
		{
			layer_instances = this.layers[i].instances;
			
			for (j = 0, lenj = layer_instances.length; j < lenj; j++)
			{
				inst = layer_instances[j];
				
				if (!inst.type.global)
				{
					this.runtime.DestroyInstance(inst);
				}
			}
			
			this.runtime.ClearDeathRow();
			
			// Clear layer instances.  startRunning() picks up global objects and moves them to the new layout's layers.
			cr.clearArray(layer_instances);
			this.layers[i].zindices_stale = true;
		}
		
		// Destroy all non-global, non-world object type instances
		for (i = 0, leni = this.runtime.types_by_index.length; i < leni; i++)
		{
			type = this.runtime.types_by_index[i];
			
			// note we don't do this for families, we iterate the non-family types anyway
			if (type.global || type.plugin.is_world || type.plugin.singleglobal || type.is_family)
				continue;
				
			for (j = 0, lenj = type.instances.length; j < lenj; j++)
				this.runtime.DestroyInstance(type.instances[j]);
				
			this.runtime.ClearDeathRow();
		}
		
		first_layout = false;
		this.runtime.isEndingLayout = false;
	};
	
	var temp_rect = new cr.rect(0, 0, 0, 0);
	
	Layout.prototype.recreateInitialObjects = function (type, x1, y1, x2, y2)
	{
		temp_rect.set(x1, y1, x2, y2);
		
		var i, len;
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			this.layers[i].recreateInitialObjects(type, temp_rect);
		}
	};

	Layout.prototype.draw = function (ctx)
	{
		var layout_canvas;
		var layout_ctx = ctx;
		var ctx_changed = false;
		
		// Must render to off-screen canvas when using low-res fullscreen mode, then stretch back up
		var render_offscreen = !this.runtime.fullscreenScalingQuality;
		
		if (render_offscreen)
		{
			// Need another canvas to render to.  Ensure it is created.
			if (!this.runtime.layout_canvas)
			{
				this.runtime.layout_canvas = document.createElement("canvas");
				layout_canvas = this.runtime.layout_canvas;
				layout_canvas.width = this.runtime.draw_width;
				layout_canvas.height = this.runtime.draw_height;
				this.runtime.layout_ctx = layout_canvas.getContext("2d");
				ctx_changed = true;
			}

			layout_canvas = this.runtime.layout_canvas;
			layout_ctx = this.runtime.layout_ctx;

			// Window size has changed (browser fullscreen mode)
			if (layout_canvas.width !== this.runtime.draw_width)
			{
				layout_canvas.width = this.runtime.draw_width;
				ctx_changed = true;
			}
			if (layout_canvas.height !== this.runtime.draw_height)
			{
				layout_canvas.height = this.runtime.draw_height;
				ctx_changed = true;
			}
			
			if (ctx_changed)
			{
				layout_ctx.imageSmoothingEnabled = this.runtime.linearSampling;
			}
		}
		
		layout_ctx.globalAlpha = 1;
		layout_ctx.globalCompositeOperation = "source-over";
		
		// Clear canvas with transparent
		if (this.runtime.clearBackground && !this.hasOpaqueBottomLayer())
			layout_ctx.clearRect(0, 0, this.runtime.draw_width, this.runtime.draw_height);

		// Draw each layer
		var i, len, l;
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			l = this.layers[i];
			
			// Blend mode 11 means effect fallback is 'hide layer'
			// Note: transparent layers with zero instances are skipped
			if (l.visible && l.opacity > 0 && l.blend_mode !== 11 && (l.instances.length || !l.transparent))
				l.draw(layout_ctx);
			else
				l.updateViewport(null);		// even if not drawing, keep viewport up to date
		}
		
		// If rendered to texture, paste to main display now at full size
		if (render_offscreen)
		{
			ctx.drawImage(layout_canvas, 0, 0, this.runtime.width, this.runtime.height);
		}
	};
	
	Layout.prototype.drawGL_earlyZPass = function (glw)
	{
		glw.setEarlyZPass(true);
		
		// render_to_texture is implied true. Ensure the texture to render to is created.
		if (!this.runtime.layout_tex)
		{
			this.runtime.layout_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
		}

		// Window size has changed (browser fullscreen mode)
		if (this.runtime.layout_tex.c2width !== this.runtime.draw_width || this.runtime.layout_tex.c2height !== this.runtime.draw_height)
		{
			glw.deleteTexture(this.runtime.layout_tex);
			this.runtime.layout_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
		}
		
		glw.setRenderingToTexture(this.runtime.layout_tex);
		
		if (!this.runtime.fullscreenScalingQuality)
		{
			glw.setSize(this.runtime.draw_width, this.runtime.draw_height);
		}
		
		// Early-pass layers in front-to-back order
		var i, l;
		for (i = this.layers.length - 1; i >= 0; --i)
		{
			l = this.layers[i];
			
			// Only early-pass render layers which preserve opaqueness
			if (l.visible && l.opacity === 1 && l.shaders_preserve_opaqueness &&
				l.blend_mode === 0 && (l.instances.length || !l.transparent))
			{
				l.drawGL_earlyZPass(glw);
			}
			else
			{
				l.updateViewport(null);		// even if not drawing, keep viewport up to date
			}
		}
		
		glw.setEarlyZPass(false);
	};
	
	Layout.prototype.drawGL = function (glw)
	{
		// Render whole layout to texture if:
		// 1) layout has effects (needs post-process)
		// 2) any background blending effects are in use (need to sample from texture during rendering)
		// 3) "Fullscreen scaling quality" is "Low" (need to render at low-res and scale up after)
		// 4) we're using front-to-back rendering mode, where we must attach the depth buffer while rendering
		//    the display to a texture
		var render_to_texture = (this.active_effect_types.length > 0 ||
								 this.runtime.uses_background_blending ||
								 !this.runtime.fullscreenScalingQuality ||
								 this.runtime.enableFrontToBack);
		
		if (render_to_texture)
		{
			// Need another canvas to render to.  Ensure it is created.
			if (!this.runtime.layout_tex)
			{
				this.runtime.layout_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}

			// Window size has changed (browser fullscreen mode)
			if (this.runtime.layout_tex.c2width !== this.runtime.draw_width || this.runtime.layout_tex.c2height !== this.runtime.draw_height)
			{
				glw.deleteTexture(this.runtime.layout_tex);
				this.runtime.layout_tex = glw.createEmptyTexture(this.runtime.draw_width, this.runtime.draw_height, this.runtime.linearSampling);
			}
			
			glw.setRenderingToTexture(this.runtime.layout_tex);
			
			if (!this.runtime.fullscreenScalingQuality)
			{
				glw.setSize(this.runtime.draw_width, this.runtime.draw_height);
			}
		}
		// Not rendering to texture any more. Clean up layout_tex to save memory.
		else
		{
			if (this.runtime.layout_tex)
			{
				glw.setRenderingToTexture(null);
				glw.deleteTexture(this.runtime.layout_tex);
				this.runtime.layout_tex = null;
			}
		}
		
		if (this.runtime.clearBackground && !this.hasOpaqueBottomLayer())
			glw.clear(0, 0, 0, 0);

		// Draw each layer
		var i, len, l;
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			l = this.layers[i];
			
			if (l.visible && l.opacity > 0 && (l.instances.length || !l.transparent))
				l.drawGL(glw);
			else
				l.updateViewport(null);		// even if not drawing, keep viewport up to date
		}
		
		// If rendered to texture, paste to main display now
		if (render_to_texture)
		{
			// With one effect, it still must be post-drawn in low-res fullscreen mode otherwise
			// it may use the full resolution of the backbuffer
			if (this.active_effect_types.length === 0 ||
				(this.active_effect_types.length === 1 && this.runtime.fullscreenScalingQuality))
			{
				if (this.active_effect_types.length === 1)
				{
					var etindex = this.active_effect_types[0].index;
					
					var viewRect = this.calculateViewRect();
					
					glw.switchProgram(this.active_effect_types[0].shaderindex);
					glw.setProgramParameters(null,								// backTex
											 1.0 / this.runtime.draw_width,		// pixelWidth
											 1.0 / this.runtime.draw_height,	// pixelHeight
											 0.0, 0.0,							// srcStart
											 1.0, 1.0,							// srcEnd
											 0.0, 0.0,							// srcOriginStart
											 1.0, 1.0,							// srcOriginEnd
											 viewRect.left, viewRect.top,		// layoutStart
											 viewRect.right, viewRect.bottom,	// layoutEnd
											 0.0, 0.0,							// destStart
											 1.0, 1.0,							// destEnd
											 this.scale,						// layerScale
											 this.angle,						// layerAngle
											 this.runtime.kahanTime.sum,		// seconds
											 this.effect_params[etindex]);		// fx parameters
											 
					if (glw.programIsAnimated(this.active_effect_types[0].shaderindex))
						this.runtime.redraw = true;
				}
				else
					glw.switchProgram(0);
				
				if (!this.runtime.fullscreenScalingQuality)
				{
					glw.setSize(this.runtime.width, this.runtime.height);
				}
					
				glw.setRenderingToTexture(null);				// to backbuffer
				glw.setDepthTestEnabled(false);					// ignore depth buffer, copy full texture
				glw.setOpacity(1);
				glw.setTexture(this.runtime.layout_tex);
				glw.setAlphaBlend();
				glw.resetModelView();
				glw.updateModelView();
				var halfw = this.runtime.width / 2;
				var halfh = this.runtime.height / 2;
				glw.quad(-halfw, halfh, halfw, halfh, halfw, -halfh, -halfw, -halfh);
				glw.setTexture(null);
				glw.setDepthTestEnabled(true);					// turn depth test back on
			}
			else
			{
				this.renderEffectChain(glw, null, null, null);
			}
		}
	};
	
	Layout.prototype.getRenderTarget = function()
	{
		if (this.active_effect_types.length > 0 ||
				this.runtime.uses_background_blending ||
				!this.runtime.fullscreenScalingQuality ||
				this.runtime.enableFrontToBack)
		{
			return this.runtime.layout_tex;
		}
		else
		{
			return null;
		}
	};
	
	Layout.prototype.getMinLayerScale = function ()
	{
		var m = this.layers[0].getScale();
		var i, len, l;
		
		for (i = 1, len = this.layers.length; i < len; i++)
		{
			l = this.layers[i];
			
			if (l.parallaxX === 0 && l.parallaxY === 0)
				continue;
			
			if (l.getScale() < m)
				m = l.getScale();
		}
		
		return m;
	};

	Layout.prototype.scrollToX = function (x)
	{
		// Apply bounding
		if (!this.unbounded_scrolling)
		{
			var widthBoundary = (this.runtime.draw_width * (1 / this.getMinLayerScale()) / 2);
			
			if (x > this.width - widthBoundary)
				x = this.width - widthBoundary;
				
			// Note window width may be larger than layout width for browser fullscreen mode,
			// so prefer clamping to left
			if (x < widthBoundary)
				x = widthBoundary;
		}

		if (this.scrollX !== x)
		{
			this.scrollX = x;
			this.runtime.redraw = true;
		}
	};

	Layout.prototype.scrollToY = function (y)
	{		
		// Apply bounding
		if (!this.unbounded_scrolling)
		{
			var heightBoundary = (this.runtime.draw_height * (1 / this.getMinLayerScale()) / 2);
			
			if (y > this.height - heightBoundary)
				y = this.height - heightBoundary;
				
			// Note window width may be larger than layout width for browser fullscreen mode,
			// so prefer clamping to top
			if (y < heightBoundary)
				y = heightBoundary;
		}

		if (this.scrollY !== y)
		{
			this.scrollY = y;
			this.runtime.redraw = true;
		}
	};
	
	Layout.prototype.boundScrolling = function ()
	{
		this.scrollToX(this.scrollX);
		this.scrollToY(this.scrollY);
	};
	
	Layout.prototype.calculateViewRect = function ()
	{
		var px = this.scrollX;
		var py = this.scrollY;
		var invScale = 1 / (this.scale * this.runtime.aspect_scale);
		px -= (this.runtime.width * invScale) / 2;
		py -= (this.runtime.height * invScale) / 2;
		this.viewRect.set(
			px,
			py,
			px + this.runtime.draw_width * invScale,
			py + this.runtime.draw_height * invScale
		);
		return this.viewRect;
	};
	
	Layout.prototype.renderEffectChain = function (glw, layer, inst, rendertarget)
	{
		var active_effect_types = inst ?
							inst.active_effect_types :
							layer ?
								layer.active_effect_types :
								this.active_effect_types;
		
		var layerScale = 1, layerAngle = 0, viewOriginLeft = 0, viewOriginTop = 0, viewOriginRight = this.runtime.draw_width, viewOriginBottom = this.runtime.draw_height;
		
		if (inst)
		{
			layerScale = inst.layer.getScale();
			layerAngle = inst.layer.getAngle();
			viewOriginLeft = inst.layer.viewLeft;
			viewOriginTop = inst.layer.viewTop;
			viewOriginRight = inst.layer.viewRight;
			viewOriginBottom = inst.layer.viewBottom;
		}
		else if (layer)
		{
			layerScale = layer.getScale();
			layerAngle = layer.getAngle();
			viewOriginLeft = layer.viewLeft;
			viewOriginTop = layer.viewTop;
			viewOriginRight = layer.viewRight;
			viewOriginBottom = layer.viewBottom;
		}
		else
		{
			layerScale = this.scale;
			layerAngle = this.angle;
			var viewRect = this.calculateViewRect();
			viewOriginLeft = viewRect.left;
			viewOriginTop = viewRect.top;
			viewOriginRight = viewRect.right;
			viewOriginBottom = viewRect.bottom;
		}
		
		var fx_tex = this.runtime.fx_tex;
		var i, len, last, temp, fx_index = 0, other_fx_index = 1;
		var y, h;
		var windowWidth = this.runtime.draw_width;
		var windowHeight = this.runtime.draw_height;
		var halfw = windowWidth / 2;
		var halfh = windowHeight / 2;
		var rcTexBounce = layer ? layer.rcTexBounce : this.rcTexBounce;
		var rcTexDest = layer ? layer.rcTexDest : this.rcTexDest;
		var rcTexOrigin = layer ? layer.rcTexOrigin : this.rcTexOrigin;
		
		var screenleft = 0, clearleft = 0;
		var screentop = 0, cleartop = 0;
		var screenright = windowWidth, clearright = windowWidth;
		var screenbottom = windowHeight, clearbottom = windowHeight;
		
		var boxExtendHorizontal = 0;
		var boxExtendVertical = 0;
		var inst_layer_angle = inst ? inst.layer.getAngle() : 0;
		
		if (inst)
		{
			// Determine total box extension
			for (i = 0, len = active_effect_types.length; i < len; i++)
			{
				boxExtendHorizontal += glw.getProgramBoxExtendHorizontal(active_effect_types[i].shaderindex);
				boxExtendVertical += glw.getProgramBoxExtendVertical(active_effect_types[i].shaderindex);
			}
		
			// Project instance to screen
			var bbox = inst.bbox;
			screenleft = layer.layerToCanvas(bbox.left, bbox.top, true, true);
			screentop = layer.layerToCanvas(bbox.left, bbox.top, false, true);
			screenright = layer.layerToCanvas(bbox.right, bbox.bottom, true, true);
			screenbottom = layer.layerToCanvas(bbox.right, bbox.bottom, false, true);
			
			// Take in to account layer rotation if any
			if (inst_layer_angle !== 0)
			{
				var screentrx = layer.layerToCanvas(bbox.right, bbox.top, true, true);
				var screentry = layer.layerToCanvas(bbox.right, bbox.top, false, true);
				var screenblx = layer.layerToCanvas(bbox.left, bbox.bottom, true, true);
				var screenbly = layer.layerToCanvas(bbox.left, bbox.bottom, false, true);
				temp = Math.min(screenleft, screenright, screentrx, screenblx);
				screenright = Math.max(screenleft, screenright, screentrx, screenblx);
				screenleft = temp;
				temp = Math.min(screentop, screenbottom, screentry, screenbly);
				screenbottom = Math.max(screentop, screenbottom, screentry, screenbly);
				screentop = temp;
			}
			
			// Get unclamped, unextended source texture co-ordinates (the original box)
			rcTexOrigin.left = screenleft / windowWidth;
			rcTexOrigin.top = 1 - screentop / windowHeight;
			rcTexOrigin.right = screenright / windowWidth;
			rcTexOrigin.bottom = 1 - screenbottom / windowHeight;
			
			screenleft -= boxExtendHorizontal;
			screentop -= boxExtendVertical;
			screenright += boxExtendHorizontal;
			screenbottom += boxExtendVertical;
			
			// Unclamped texture coords
			rcTexDest.left = screenleft / windowWidth;
			rcTexDest.top = 1 - screentop / windowHeight;
			rcTexDest.right = screenright / windowWidth;
			rcTexDest.bottom = 1 - screenbottom / windowHeight;
			
			clearleft = screenleft = cr.floor(screenleft);
			cleartop = screentop = cr.floor(screentop);
			clearright = screenright = cr.ceil(screenright);
			clearbottom = screenbottom = cr.ceil(screenbottom);
			
			// Extend clear area by box extension again to prevent sampling nonzero pixels outside the box area
			// (especially for blur).
			clearleft -= boxExtendHorizontal;
			cleartop -= boxExtendVertical;
			clearright += boxExtendHorizontal;
			clearbottom += boxExtendVertical;
			
			if (screenleft < 0)					screenleft = 0;
			if (screentop < 0)					screentop = 0;
			if (screenright > windowWidth)		screenright = windowWidth;
			if (screenbottom > windowHeight)	screenbottom = windowHeight;
			if (clearleft < 0)					clearleft = 0;
			if (cleartop < 0)					cleartop = 0;
			if (clearright > windowWidth)		clearright = windowWidth;
			if (clearbottom > windowHeight)		clearbottom = windowHeight;
			
			// Clamped texture coords
			rcTexBounce.left = screenleft / windowWidth;
			rcTexBounce.top = 1 - screentop / windowHeight;
			rcTexBounce.right = screenright / windowWidth;
			rcTexBounce.bottom = 1 - screenbottom / windowHeight;
		}
		else
		{
			rcTexBounce.left = rcTexDest.left = rcTexOrigin.left = 0;
			rcTexBounce.top = rcTexDest.top = rcTexOrigin.top = 0;
			rcTexBounce.right = rcTexDest.right = rcTexOrigin.right = 1;
			rcTexBounce.bottom = rcTexDest.bottom = rcTexDest.bottom = 1;
		}
		
		// Check if we need to pre-draw the object to the first render surface, with no effect.
		// This is to allow:
		// - rotated or spritesheeted objects using blending to properly blend with the background
		// - bounding boxes to be extended when the effect requires it
		// - instance or layer opacity to be taken in to account if not 100%
		var pre_draw = (inst && (glw.programUsesDest(active_effect_types[0].shaderindex) || boxExtendHorizontal !== 0 || boxExtendVertical !== 0 || inst.opacity !== 1 || inst.type.plugin.must_predraw)) || (layer && !inst && layer.opacity !== 1);
		
		// Save composite mode until last draw
		glw.setAlphaBlend();
		
		if (pre_draw)
		{
			// Not yet created this effect surface
			if (!fx_tex[fx_index])
			{
				fx_tex[fx_index] = glw.createEmptyTexture(windowWidth, windowHeight, this.runtime.linearSampling);
			}

			// Window size has changed (browser fullscreen mode)
			if (fx_tex[fx_index].c2width !== windowWidth || fx_tex[fx_index].c2height !== windowHeight)
			{
				glw.deleteTexture(fx_tex[fx_index]);
				fx_tex[fx_index] = glw.createEmptyTexture(windowWidth, windowHeight, this.runtime.linearSampling);
			}
			
			glw.switchProgram(0);
			glw.setRenderingToTexture(fx_tex[fx_index]);
			
			// Clear target rectangle
			h = clearbottom - cleartop;
			y = (windowHeight - cleartop) - h;
			glw.clearRect(clearleft, y, clearright - clearleft, h);
			
			// Draw the inst or layer
			if (inst)
			{
				inst.drawGL(glw);
			}
			else
			{
				glw.setTexture(this.runtime.layer_tex);
				glw.setOpacity(layer.opacity);
				glw.resetModelView();
				glw.translate(-halfw, -halfh);
				glw.updateModelView();
				glw.quadTex(screenleft, screenbottom, screenright, screenbottom, screenright, screentop, screenleft, screentop, rcTexBounce);
			}
			
			// Set destination range to entire surface
			rcTexDest.left = rcTexDest.top = 0;
			rcTexDest.right = rcTexDest.bottom = 1;
			
			if (inst)
			{
				temp = rcTexBounce.top;
				rcTexBounce.top = rcTexBounce.bottom;
				rcTexBounce.bottom = temp;
			}
			
			// Exchange the fx surfaces
			fx_index = 1;
			other_fx_index = 0;
		}
		
		glw.setOpacity(1);
		
		var last = active_effect_types.length - 1;
		
		// If last effect uses cross-sampling or needs pre-drawing it cannot be rendered direct to target -
		// must render one more time to offscreen then copy in afterwards. Additionally, layout effects in
		// low-res fullscreen mode must post draw so they render at the draw size, then stretch up to the
		// backbuffer size afterwards.
		var post_draw = glw.programUsesCrossSampling(active_effect_types[last].shaderindex) ||
						(!layer && !inst && !this.runtime.fullscreenScalingQuality);
		
		var etindex = 0;
		
		// For each effect to render
		for (i = 0, len = active_effect_types.length; i < len; i++)
		{
			// Not yet created this effect surface
			if (!fx_tex[fx_index])
			{
				fx_tex[fx_index] = glw.createEmptyTexture(windowWidth, windowHeight, this.runtime.linearSampling);
			}

			// Window size has changed (browser fullscreen mode)
			if (fx_tex[fx_index].c2width !== windowWidth || fx_tex[fx_index].c2height !== windowHeight)
			{
				glw.deleteTexture(fx_tex[fx_index]);
				fx_tex[fx_index] = glw.createEmptyTexture(windowWidth, windowHeight, this.runtime.linearSampling);
			}
			
			// Set the shader program to use
			glw.switchProgram(active_effect_types[i].shaderindex);
			etindex = active_effect_types[i].index;
			
			if (glw.programIsAnimated(active_effect_types[i].shaderindex))
				this.runtime.redraw = true;
			
			// First effect and not pre-drawn: render instance to first effect surface
			if (i == 0 && !pre_draw)
			{
				glw.setRenderingToTexture(fx_tex[fx_index]);
				
				// Clear target rectangle
				h = clearbottom - cleartop;
				y = (windowHeight - cleartop) - h;
				glw.clearRect(clearleft, y, clearright - clearleft, h);
				
				if (inst)
				{
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
					
					glw.setProgramParameters(rendertarget,						// backTex
											 pxWidth,							// pixelWidth
											 pxHeight,							// pixelHeight
											 srcStartX, srcStartY,				// srcStart
											 srcEndX, srcEndY,					// srcEnd
											 srcStartX, srcStartY,				// srcOriginStart
											 srcEndX, srcEndY,					// srcOriginEnd
											 inst.bbox.left, inst.bbox.top,		// layoutStart
											 inst.bbox.right, inst.bbox.bottom,	// layoutEnd
											 rcTexDest.left, rcTexDest.top,		// destStart
											 rcTexDest.right, rcTexDest.bottom,	// destEnd
											 layerScale,
											 layerAngle,
											 this.runtime.kahanTime.sum,
											 inst.effect_params[etindex]);		// fx params
					
					inst.drawGL(glw);
				}
				else
				{
					glw.setProgramParameters(rendertarget,						// backTex
											 1.0 / windowWidth,					// pixelWidth
											 1.0 / windowHeight,				// pixelHeight
											 0.0, 0.0,							// srcStart
											 1.0, 1.0,							// srcEnd
											 0.0, 0.0,							// srcOriginStart
											 1.0, 1.0,							// srcOriginEnd
											 viewOriginLeft, viewOriginTop,		// layoutStart
											 viewOriginRight, viewOriginBottom,	// layoutEnd
											 0.0, 0.0,							// destStart
											 1.0, 1.0,							// destEnd
											 layerScale,
											 layerAngle,
											 this.runtime.kahanTime.sum,
											 layer ?						// fx params
												layer.effect_params[etindex] :
												this.effect_params[etindex]);
					
					glw.setTexture(layer ? this.runtime.layer_tex : this.runtime.layout_tex);
					glw.resetModelView();
					glw.translate(-halfw, -halfh);
					glw.updateModelView();
					glw.quadTex(screenleft, screenbottom, screenright, screenbottom, screenright, screentop, screenleft, screentop, rcTexBounce);
				}
				
				// Destination range now takes in to account entire surface
				rcTexDest.left = rcTexDest.top = 0;
				rcTexDest.right = rcTexDest.bottom = 1;
				
				if (inst && !post_draw)
				{
					temp = screenbottom;
					screenbottom = screentop;
					screentop = temp;
				}
			}
			// Not first effect
			else
			{
				glw.setProgramParameters(rendertarget,							// backTex
										 1.0 / windowWidth,						// pixelWidth
										 1.0 / windowHeight,					// pixelHeight
										 0.0, 0.0,								// srcStart
										 1.0, 1.0,								// srcEnd
										 rcTexOrigin.left, rcTexOrigin.top,		// srcOriginStart
										 rcTexOrigin.right, rcTexOrigin.bottom,	// srcOriginEnd
										 viewOriginLeft, viewOriginTop,			// layoutStart
										 viewOriginRight, viewOriginBottom,		// layoutEnd
										 rcTexDest.left, rcTexDest.top,			// destStart
										 rcTexDest.right, rcTexDest.bottom,		// destEnd
										 layerScale,
										 layerAngle,
										 this.runtime.kahanTime.sum,
										 inst ?								// fx params
											inst.effect_params[etindex] :
											layer ? 
												layer.effect_params[etindex] :
												this.effect_params[etindex]);
				
				// Avoid having the render target and current texture set at same time
				glw.setTexture(null);
										 
				// The last effect renders direct to display.  Otherwise render to the current effect surface
				if (i === last && !post_draw)
				{
					// Use instance or layer blend mode for last step
					if (inst)
						glw.setBlend(inst.srcBlend, inst.destBlend);
					else if (layer)
						glw.setBlend(layer.srcBlend, layer.destBlend);
						
					glw.setRenderingToTexture(rendertarget);
				}
				else
				{
					glw.setRenderingToTexture(fx_tex[fx_index]);
					
					// Clear target rectangle
					h = clearbottom - cleartop;
					y = (windowHeight - cleartop) - h;
					glw.clearRect(clearleft, y, clearright - clearleft, h);
				}
				
				// Render with the shader
				glw.setTexture(fx_tex[other_fx_index]);
				glw.resetModelView();
				glw.translate(-halfw, -halfh);
				glw.updateModelView();
				glw.quadTex(screenleft, screenbottom, screenright, screenbottom, screenright, screentop, screenleft, screentop, rcTexBounce);
				
				if (i === last && !post_draw)
					glw.setTexture(null);
			}
			
			// Alternate fx_index between 0 and 1
			fx_index = (fx_index === 0 ? 1 : 0);
			other_fx_index = (fx_index === 0 ? 1 : 0);		// will be opposite to fx_index since it was just assigned
		}
		
		// If the last effect needs post-drawing, it is still on an effect surface and not yet drawn
		// to display.  Copy it to main display now.
		if (post_draw)
		{
			glw.switchProgram(0);
			
			// Use instance or layer blend mode for last step
			if (inst)
				glw.setBlend(inst.srcBlend, inst.destBlend);
			else if (layer)
				glw.setBlend(layer.srcBlend, layer.destBlend);
			else
			{
				// Post-drawing layout effect to backbuffer: restore full viewport and stretch up last texture
				if (!this.runtime.fullscreenScalingQuality)
				{
					glw.setSize(this.runtime.width, this.runtime.height);
					halfw = this.runtime.width / 2;
					halfh = this.runtime.height / 2;
					screenleft = 0;
					screentop = 0;
					screenright = this.runtime.width;
					screenbottom = this.runtime.height;
				}
			}
			
			glw.setRenderingToTexture(rendertarget);
			glw.setTexture(fx_tex[other_fx_index]);
			glw.resetModelView();
			glw.translate(-halfw, -halfh);
			glw.updateModelView();
			
			if (inst && active_effect_types.length === 1 && !pre_draw)
				glw.quadTex(screenleft, screentop, screenright, screentop, screenright, screenbottom, screenleft, screenbottom, rcTexBounce);
			else
				glw.quadTex(screenleft, screenbottom, screenright, screenbottom, screenright, screentop, screenleft, screentop, rcTexBounce);
			
			glw.setTexture(null);
		}
	};
	
	Layout.prototype.getLayerBySid = function (sid_)
	{
		var i, len;
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			if (this.layers[i].sid === sid_)
				return this.layers[i];
		}
		
		return null;
	};
	
	Layout.prototype.saveToJSON = function ()
	{
		var i, len, layer, et;
		
		var o = {
			"sx": this.scrollX,
			"sy": this.scrollY,
			"s": this.scale,
			"a": this.angle,
			"w": this.width,
			"h": this.height,
			"fv": this.first_visit,			// added r127
			"persist": this.persist_data,
			"fx": [],
			"layers": {}
		};
		
		for (i = 0, len = this.effect_types.length; i < len; i++)
		{
			et = this.effect_types[i];
			o["fx"].push({"name": et.name, "active": et.active, "params": this.effect_params[et.index] });
		}
		
		for (i = 0, len = this.layers.length; i < len; i++)
		{
			layer = this.layers[i];
			o["layers"][layer.sid.toString()] = layer.saveToJSON();
		}
		
		return o;
	};
	
	Layout.prototype.loadFromJSON = function (o)
	{
		var i, j, len, fx, p, layer;
		
		this.scrollX = o["sx"];
		this.scrollY = o["sy"];
		this.scale = o["s"];
		this.angle = o["a"];
		this.width = o["w"];
		this.height = o["h"];
		this.persist_data = o["persist"];
		
		// first visit added r127, check it exists before loading
		if (typeof o["fv"] !== "undefined")
			this.first_visit = o["fv"];
		
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
		
		// Load layers
		var olayers = o["layers"];
		
		for (p in olayers)
		{
			if (olayers.hasOwnProperty(p))
			{
				layer = this.getLayerBySid(parseInt(p, 10));
				
				if (!layer)
					continue;		// must've gone missing
					
				layer.loadFromJSON(olayers[p]);
			}
		}
	};
	
	cr.layout = Layout;
	
}());

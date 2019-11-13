"use strict";

// Diagnostic for preview only
let shownAssertAlert = false;

function assert2(cnd, msg)
{
	if (!cnd)
	{
		debugger;
		
		let stack;
		
		try {
			throw Error();
		} catch(ex) {
			stack = ex.stack;
		}
		
		let msg2 = "Assertion failure: " + msg + "\n\nStack trace: \n" + stack;
		
		if (!shownAssertAlert)
		{
			shownAssertAlert = true;
			alert(msg2 + "\n\nSubsequent failures will now be logged to the console.");
		}
		
		if (console.error)
			console.error(msg2);
	}
};
// Show javascript errors in preview, since most users don't check the browser log. Only show first error
let shownErrorAlert = false;

window.onerror = function(msg, url, line, col)
{
	if (shownErrorAlert)
		return;
	
	// Turn off mysterious "Script error." on line 0 with no URL errors in Firefox & Chrome
	if (!msg || !url || msg === "Script error.")
		return;
	
	shownErrorAlert = true;
	alert("Javascript error!\n" + msg + "\n" + url + ", line " + line + " (col " + col + ")\n\n" + "This may be a bug in Construct 3 or a third party plugin or behavior - please report it to the developer following the bug report guidelines. Subsequent errors will be logged to the console.");
};

function log(msg, type)
{
	// console logging seems to crash IE9 sometimes, so never log for IE
	if (typeof console !== "undefined" && console.log && navigator.userAgent.indexOf("MSIE") === -1)
	{
		if (type === "warn" && console.warn)
			console.warn(msg);
		else
			console.log(msg);
	}
};

///////////////////////////////////////
// Debugger utilities

// Work around stupid Firefox exceptions if you change privacy settings
function localStorage_getItem(key)
{
	try {
		return localStorage.getItem(key);
	}
	catch (e)
	{
		return null;
	}
};

function localStorage_setItem(key, value)
{
	try {
		localStorage.setItem(key, value);
	}
	catch (e)
	{
		// ignore
	}
};

// Properties to watch in the format: watch[uid][header] = [propname1, propname2, ...]
let watch = {};

// Load any previously used watch items
function LoadWatchItems()
{
	watch = JSON.parse(localStorage_getItem("__c2_watch") || "{}");
};

if (document.readyState === "loading")
	document.addEventListener("DOMContentLoaded", LoadWatchItems);
else
	LoadWatchItems();

function PostToDebugger(data)
{
	if (!window["c3_postToMessagePort"])
		return;
	
	data["from"] = "runtime";
	
	// Post down the MessageChannel
	window["c3_postToMessagePort"](data);
};

// Runtime instance currently being inspected by debugger
let inspectInst = null;
let inspectSystem = false;
let highlightEnabled = true;
let currentMode = "inspect";

function IsDebuggerProfiling()
{
	return currentMode === "profile";
};

// On message from debugger. Note this comes from the MessageChannel port.
function OnMessageFromDebugger(data)
{
	let type = data["type"];
	let runtime = window["c3runtime"];
	
	if (type === "inspectinstance")
	{
		OnInspectInstanceMessage(data);
	}
	else if (type === "add-watch")
	{
		OnAddWatchMessage(data);
	}
	else if (type === "add-watch-header")
	{
		OnAddWatchHeaderMessage(data);
	}
	else if (type === "remove-watch")
	{
		OnRemoveWatchMessage(data);
	}
	else if (type === "remove-watch-header")
	{
		OnRemoveWatchHeaderMessage(data);
	}
	else if (type === "editvalue")
	{
		OnEditValueMessage(data);
	}
	else if (type === "pause")
	{
		runtime["setSuspended"](true);
		UpdateInspectedInstance();
	}
	else if (type === "resume")
	{
		runtime["setSuspended"](false);
	}
	else if (type === "resumebreakpoint")
	{
		runtime.step_break = false;
		runtime.debugResume();
	}
	else if (type === "step")
	{
		OnStep();
	}
	else if (type === "save")
	{
		OnSaveMessage();
	}
	else if (type === "load")
	{
		OnLoadMessage();
	}
	else if (type === "highlight")
	{
		highlightEnabled = data["enabled"];
	}
	else if (type === "switchtab")
	{
		OnSwitchTabMessage(data);
	}
	else if (type === "restart")
	{
		window.location.reload(true);
	}
	else if (type === "destroy-inspect-inst")
	{
		if (inspectInst)
			runtime.DestroyInstance(inspectInst);
	}
	else if (type === "update-breakpoint")
	{
		OnBreakpointUpdate(data);
	}
	// When the debugger is popped out to a window, or collapsed back to a pane, it is effectively
	// reset. It needs to know about all object types again, so they're reposted.
	else if (type === "repostinit")
	{
		DebuggerInit(runtime);
	}
	else
	{
		console.warn("[Runtime] Unknown message from debugger: '" + type + "'");
	}
};

// Note handler is missing in remote preview
if (window["c3_addPortMessageHandler"])
	window["c3_addPortMessageHandler"](OnMessageFromDebugger);

function OnInspectInstanceMessage(data)
{
	currentMode = "inspect";
	
	let runtime = window["c3runtime"];
	let typename = data["typename"];
	
	// Inspecting System
	if (typename === "System")
	{
		inspectInst = null;
		inspectSystem = true;
	}
	// Inspecting object instance
	else
	{
		highlightEnabled = true;
		
		if (data.hasOwnProperty("uid"))
		{
			inspectInst = runtime.getObjectByUID(data["uid"]);
			inspectSystem = false;
		}
		else
		{
			let objectType = runtime.types[typename];
			let iid = data["iid"];
			
			if (objectType && iid >= 0 && iid < objectType.instances.length)
			{
				inspectInst = objectType.instances[iid];
				inspectSystem = false;
			}
		}
	}
	
	UpdateInspectedInstance();
};

function OnAddWatchMessage(data)
{
	if (ife)
	{
		PostToDebugger({"type": "nocando"});
		return;
	}
	
	OnAddToWatch(data["headerTitle"], data["propertyName"]);
	UpdateInspectedInstance();
	localStorage_setItem("__c2_watch", JSON.stringify(watch));
};

function OnAddWatchHeaderMessage(data)
{
	if (ife)
	{
		PostToDebugger({"type": "nocando"});
		return;
	}
	
	OnAddToWatchHeader(data["headerTitle"], data["propertyNames"]);
	UpdateInspectedInstance();
	localStorage_setItem("__c2_watch", JSON.stringify(watch));
};

function OnRemoveWatchMessage(data)
{
	OnRemoveFromWatch(data["headerTitle"], data["displayTitle"], data["propertyName"]);
	UpdateInspectedInstance();
	localStorage_setItem("__c2_watch", JSON.stringify(watch));
};

function OnRemoveWatchHeaderMessage(data)
{
	OnRemoveFromWatchHeader(data["headerTitle"], data["displayTitle"]);
	UpdateInspectedInstance();
	localStorage_setItem("__c2_watch", JSON.stringify(watch));
};

function OnEditValueMessage(data)
{
	OnDebugValueEdited(data["header"], data["displayHeader"], data["name"], data["value"]);
	UpdateInspectedInstance();
};

function OnSaveMessage()
{
	let runtime = window["c3runtime"];
	runtime.saveToSlot = "__c2_debuggerslot";
	
	// If suspended, step with a zero dt to make the save/load happen
	if (runtime.isSuspended)
	{
		runtime.last_tick_time = cr.performance_now();
		runtime.tick(false);
	}
};

function OnLoadMessage()
{
	let runtime = window["c3runtime"];
	runtime.loadFromSlot = "__c2_debuggerslot";
	
	// If suspended, step with a zero dt to make the save/load happen
	if (runtime.isSuspended)
	{
		runtime.last_tick_time = cr.performance_now();
		runtime.tick(false);
		
		// Load happens async; when it finishes loading it will also fire another tick
		// if in the debugger and suspended
	}
};

function OnSwitchTabMessage(data)
{
	if (ife && data["mode"] !== "inspect")
	{
		PostToDebugger({"type": "nocando"});
	}
	else
	{
		currentMode = data["mode"];
	}
};

function GetDebuggerPropertiesForUID(uid, propsections)
{
	let runtime = window["c3runtime"];
	
	if (!runtime)
		return;
	
	if (uid === -1)		// system
	{
		runtime.system.getDebuggerValues(propsections);
	}
	else
	{
		let inst = runtime.getObjectByUID(uid);
		
		if (!inst)
			return;
		
		propsections.push({
			"title": ["common-props.common.title"],
			"properties": [
				{"name": ["common-props.common.name"], "value": inst.type.name, "readonly": true},
				{"name": ["common-props.common.uid"], "value": inst.uid, "readonly": true},
				{"name": ["common-props.common.iid"], "value": inst.get_iid(), "readonly": true}
			]
		});
		
		if (inst.type.plugin.is_world)
		{
			propsections.push({
				"title": ["common-props.layout.title"],
				"properties": [
					{"name": ["common-props.layout.x"], "value": inst.x},
					{"name": ["common-props.layout.y"], "value": inst.y},
					{"name": ["common-props.layout.width"], "value": inst.width},
					{"name": ["common-props.layout.height"], "value": inst.height},
					{"name": ["common-props.layout.angle"], "value": cr.to_degrees(inst.angle)},
					{"name": ["common-props.layout.opacity"], "value": inst.opacity * 100},
					{"name": ["common-props.layout.visible"], "value": inst.visible},
					{"name": ["common-props.layout.layer"], "value": inst.layer.name, "readonly": true},
					{"name": ["common-props.layout.z-index"], "value": inst.get_zindex(), "readonly": true},
					{"name": ["common-props.layout.collisions-enabled"], "value": inst.collisionsEnabled}
				]
			});
		}
		
		let varprops = [];
		
		if (inst.instance_vars && inst.instance_vars.length)
		{
			for (let i = 0, len = inst.instance_vars.length; i < len; ++i)
			{
				varprops.push({
					"name": inst.instance_var_names[i],
					"value": inst.instance_vars[i]
				});
			}
			
			propsections.push({
				"title": ["common-props.instance-variables"],
				"properties": varprops
			});
		}
		
		if (inst.behavior_insts && inst.behavior_insts.length)
		{
			for (let i = 0, len = inst.behavior_insts.length; i < len; ++i)
			{
				let b = inst.behavior_insts[i];
				
				if (b.getDebuggerValues)
					b.getDebuggerValues(propsections);
			}
		}
		
		if (inst.getDebuggerValues)
			inst.getDebuggerValues(propsections);
	}
};

// Send new property values for the currently inspected instance. Called every 100ms
function UpdateInspectedInstance()
{
	// Update outline around inspected inst
	DebuggerShowInspectInstance();
	
	if (currentMode === "inspect")
	{
		let propsections = [];
		
		if (inspectSystem)
		{
			GetDebuggerPropertiesForUID(-1, propsections);
			
			PostToDebugger({
				"type": "inst-inspect",
				"is_world": false,
				"sections": propsections
			});
		}
		else if (inspectInst)
		{
			GetDebuggerPropertiesForUID(inspectInst.uid, propsections);
			
			// List all sibling UIDs to be able to jump around container from debugger
			let siblings = [];
			
			if (inspectInst.siblings)
			{
				for (let i = 0, len = inspectInst.siblings.length; i < len; ++i)
				{
					siblings.push({
						"typename": inspectInst.siblings[i].type.name,
						"uid": inspectInst.siblings[i].uid
					});
				}
			}
			
			PostToDebugger({
				"type": "inst-inspect",
				"is_world": inspectInst.type.plugin.is_world,
				"siblings": siblings,
				"sections": propsections
			});
		}
	}
	else if (currentMode === "watch")
	{
		let watchsections = [];
		let runtime = window["c3runtime"];
		
		if (!runtime)
			return;
		
		// Iterate every instance in the watch
		for (let p in watch)
		{
			let inst = null;
			
			if (p !== "-1")
			{
				inst = runtime.getObjectByUID(parseInt(p, 10));
				
				if (!inst)
				{
					// Must have been destroyed - remove watch record
					delete watch[p];
					continue;
				}
			}
			
			let propsections = [];
			GetDebuggerPropertiesForUID(parseInt(p, 10), propsections);
			
			// Copy just the watched header/properties to watchsections
			let curwatch = watch[p];
			
			// For each header available
			for (let i = 0, len = propsections.length; i < len; ++i)
			{
				let section = propsections[i];
				
				// This header is being watched. Note when used from a language lookup, a dollar prefix is attached
				let sectionTitle = section["title"];
				if (Array.isArray(sectionTitle))
					sectionTitle = "$" + sectionTitle.join(",");
				
				if (curwatch.hasOwnProperty(sectionTitle))
				{
					let watchprops = curwatch[sectionTitle];
					let sendwatchprops = [];
					
					// For each property in this header
					for (let j = 0, lenj = section["properties"].length; j < lenj; ++j)
					{
						let prop = section["properties"][j];
						let propName = prop["name"];
						if (Array.isArray(propName))
							propName = propName.join(",");
						
						// This property is being watched
						if (watchprops.indexOf(propName) > -1)
						{
							// Add to watch sections
							sendwatchprops.push(prop);
						}
					}
					
					if (sendwatchprops.length)
					{
						let watchvalues = {
							"title": [(p === "-1" ? "$system-object-name" : "$watch.instance-uid," + inst.type.name + "," + p), ": ", sectionTitle],
							"originalTitle": sectionTitle,
							"properties": sendwatchprops
						};
						
						watchsections.push(watchvalues);
					}
				}
			}
		}
		
		PostToDebugger({
			"type": "watch-inspect",
			"sections": watchsections
		});
	}
};

window.setInterval(UpdateInspectedInstance, 100);

function OnDebugValueEdited(header, displayHeader, name, value)
{
	if (ife)
	{
		PostToDebugger({"type": "nocando-edit"});
		return;		// don't be a leet hax0r and edit this... help support us and buy a license!
	}
	
	if (header.charAt(0) === "$")
		header = header.substr(1);
	
	let runtime = window["c3runtime"];
	
	let myInspectSystem = inspectSystem;
	let myInspectInst = inspectInst;
	
	if (currentMode === "watch")
	{
		let uid = GetUidFromTitle(displayHeader);
		
		if (uid === -1)
		{
			myInspectSystem = true;
			myInspectInst = null;
		}
		else if (runtime)
		{
			myInspectSystem = false;
			myInspectInst = runtime.getObjectByUID(uid);
			
			if (!myInspectInst)
				return;
		}
		else
			return;
	}
	
	if (runtime)
		runtime.redraw = true;
	
	if (myInspectSystem)
	{
		if (runtime)
		{
			runtime.system.onDebugValueEdited(header, name, value);
		}
	}
	else if (myInspectInst)
	{
		// Handle default properties
		if (header === "common-props.layout.title")
		{
			switch (name) {
			case "common-props.layout.x":
				myInspectInst.x = value;
				myInspectInst.set_bbox_changed();
				return;
			case "common-props.layout.y":
				myInspectInst.y = value;
				myInspectInst.set_bbox_changed();
				return;
			case "common-props.layout.width":
				myInspectInst.width = value;
				myInspectInst.set_bbox_changed();
				return;
			case "common-props.layout.height":
				myInspectInst.height = value;
				myInspectInst.set_bbox_changed();
				return;
			case "common-props.layout.angle":
				myInspectInst.angle = cr.to_radians(value);
				myInspectInst.set_bbox_changed();
				return;
			case "common-props.layout.opacity":
				myInspectInst.opacity = cr.clamp(value / 100, 0, 1);
				return;
			case "common-props.layout.visible":
				myInspectInst.visible = value;
				myInspectInst.runtime.redraw = true;
				return;
			case "common-props.layout.collisions-enabled":
				myInspectInst.collisionsEnabled = value;
				return;
			}
		}
		// Handle instance variable changes
		else if (header === "common-props.instance-variables")
		{
			// Find instance variable with given name
			for (let i = 0, len = myInspectInst.instance_var_names.length; i < len; ++i)
			{
				let v = myInspectInst.instance_var_names[i];
				
				if (v === name)
				{
					myInspectInst.instance_vars[i] = value;
					return;
				}
			}
		}
		
		// Try to find a behavior with this header name and pass the call to it
		if (myInspectInst.behavior_insts)
		{
			for (let i = 0, len = myInspectInst.behavior_insts.length; i < len; ++i)
			{
				let binst = myInspectInst.behavior_insts[i];
				
				if (binst.type.name === header)
				{
					if (binst.onDebugValueEdited)
					{
						binst.onDebugValueEdited(header, name, value);
						return;
					}
				}
			}
		}
		
		// Pass on to plugin to handle
		if (myInspectInst.onDebugValueEdited)
			myInspectInst.onDebugValueEdited(header, name, value);
	}
};

function SortNameAZ(a, b)
{
	let alower = a.name.toLowerCase();
	let blower = b.name.toLowerCase();
	
	if (alower > blower)
		return 1;
	if (alower < blower)
		return -1;
	else
		return 0;
};

function DebuggerLoadingProgress(x)
{
	PostToDebugger({
		"type": "loadingprogress",
		"progress": x
	});
};

function DebuggerInit(runtime)
{
	// Send a list of all object type names in the project, sorted A-Z
	let objs = [];
	let sortedTypes = [];
	cr.shallowAssignArray(sortedTypes, runtime.types_by_index);
	sortedTypes.sort(SortNameAZ);
	
	let i, len, object_type;
	for (i = 0, len = sortedTypes.length; i < len; ++i)
	{
		object_type = sortedTypes[i];
		objs.push({
			"name": object_type.name,
			"world": object_type.plugin.is_world,
			"singleglobal": object_type.plugin.singleglobal,
			"instances": object_type.instances.length
		});
	}
	
	PostToDebugger({
		"type": "init",
		"paused": runtime.isSuspended,
		"objects": objs
	});
	
	// Start off initial inspect on the System object
	if (!inspectInst)
		inspectSystem = true;
};

function DebuggerOnHitBreakpoint(data)
{
	PostToDebugger(Object.assign({
		"type": "hit-breakpoint",
	}, data));
};

function DebuggerOnResume(data)
{
	PostToDebugger(Object.assign({
		"type": "debug-resume",
	}, data));
};

function DebuggerSuspended(s, h, e)
{
	PostToDebugger({
		"type": "suspend",
		"suspended": s,
		"hit_breakpoint": h,
		"hit_event": e
	});
};

function DebuggerFullscreen(f)
{
	PostToDebugger({
		"type": "fullscreen",
		"enabled": f
	});
};

function DebuggerPerfStats(fps, cpu, gpu, mem, renderer, objectcount, rendercpu, eventscpu, physicscpu, sheets_perf)
{
	PostToDebugger({
		"type": "perfstats",
		"fps": fps,
		"cpu": cpu,
		"gpu": gpu,
		"mem": mem,
		"renderer": renderer,
		"objectcount": objectcount,
		"rendercpu": rendercpu,
		"eventscpu": eventscpu,
		"physicscpu": physicscpu,
		"sheets_perf": sheets_perf
	});
};

function DebuggerInstanceCreated(inst)
{
	// Need to send all family names to debugger so family instance lists
	// can also be updated
	let names = [inst.type.name];
	
	for (let i = 0, len = inst.type.families.length; i < len; ++i)
	{
		names.push(inst.type.families[i].name);
	}
	
	PostToDebugger({
		"type": "inst-create",
		"uid": inst.uid,
		"names": names
	});
};

function DebuggerInstanceDestroyed(inst)
{
	// If the destroyed instance was being inspected, indicate to the debugger to clear
	// the view for that instance.
	let wasInspecting = false;
	
	if (inspectInst && inspectInst.uid === inst.uid)
	{
		inspectInst = null;
		wasInspecting = true;
	}
	
	// Need to send all family names to debugger so family instance lists
	// can also be updated
	let names = [inst.type.name];
	
	for (let i = 0, len = inst.type.families.length; i < len; ++i)
	{
		names.push(inst.type.families[i].name);
	}
	
	PostToDebugger({
		"type": "inst-destroy",
		"names": names,
		"uid": inst.uid,
		"was-inspecting": wasInspecting
	});
};

let inspectOutlineElem = null;

function DebuggerShowInspectInstance()
{
	if (!inspectInst || !highlightEnabled || currentMode !== "inspect" || !inspectInst.type.plugin.is_world)
	{
		if (inspectOutlineElem)
			inspectOutlineElem.style.display = "none";
		
		return;
	}
	
	if (!inspectOutlineElem)
	{
		inspectOutlineElem = document.createElement("div");
		inspectOutlineElem.id = "inspect-outline";
		document.body.appendChild(inspectOutlineElem);
	}
	
	inspectInst.update_bbox();
	let layer = inspectInst.layer;
	let bbox = inspectInst.bbox;
	
	let p1x = layer.layerToCanvas(bbox.left, bbox.top, true);
	let p1y = layer.layerToCanvas(bbox.left, bbox.top, false);
	let p2x = layer.layerToCanvas(bbox.right, bbox.bottom, true);
	let p2y = layer.layerToCanvas(bbox.right, bbox.bottom, false);
	
	let left = cr.min(p1x, p2x) - 2;
	let top = cr.min(p1y, p2y) - 2;
	let w = cr.max(p1x, p2x) - left - 2;
	let h = cr.max(p1y, p2y) - top - 2;
	
	let canvas = window["c3canvas"];
	let canvasRc = canvas.getBoundingClientRect();
	
	inspectOutlineElem.style.display = "";
	inspectOutlineElem.style.left = (left + canvasRc.left) + "px";
	inspectOutlineElem.style.top = (top + canvasRc.top) + "px";
	inspectOutlineElem.style.width = w + "px";
	inspectOutlineElem.style.height = h + "px";
	inspectOutlineElem.textContent = inspectInst.type.name + " #" + inspectInst.get_iid();
};

function OnAddToWatch(headerTitle, propertyName)
{
	if (!inspectInst && !inspectSystem)
		return;		// not inspecting anything
	
	// First try to look up instance with same UID to see if a watch record exists for it already
	let uid = inspectInst ? inspectInst.uid : -1;
	
	// Already has record
	if (watch.hasOwnProperty(uid.toString()))
	{
		let headers = watch[uid.toString()];
		
		// Check for existing header with same name
		if (headers.hasOwnProperty(headerTitle))
		{
			let properties = headers[headerTitle];
			
			// Only add if not already added
			if (properties.indexOf(propertyName) === -1)
				properties.push(propertyName);
		}
		// Doesn't have header with this name: add new one
		else
		{
			headers[headerTitle] = [propertyName];
		}
	}
	// Doesn't have record: add a new one
	else
	{
		let properties = [propertyName];
		let headers = {};
		headers[headerTitle] = properties;
		watch[uid.toString()] = headers;
	}
};

function OnAddToWatchHeader(headerTitle, propertyNames)
{
	if (!inspectInst && !inspectSystem)
		return;		// not inspecting anything
	
	// First try to look up instance with same UID to see if a watch record exists for it already
	let uid = inspectInst ? inspectInst.uid : -1;
	
	// Already has record
	if (watch.hasOwnProperty(uid.toString()))
	{
		let headers = watch[uid.toString()];
		headers[headerTitle] = propertyNames
	}
	// Doesn't have record: add a new one
	else
	{
		let headers = {};
		headers[headerTitle] = propertyNames;
		watch[uid.toString()] = headers;
	}
};

function GetUidFromTitle(title)
{
	let i = title.indexOf(": ");
	let uidparts = title.substr(0, i).split(" ");
	if (uidparts.length <= 1)
		return -1;		// system
	return parseInt(uidparts[uidparts.length - 1], 10);
};

function OnRemoveFromWatch(headerTitle, displayTitle, propertyName)
{
	let uid = GetUidFromTitle(displayTitle);
	
	if (!watch.hasOwnProperty(uid.toString()))
		return;
	
	let headers = watch[uid.toString()];
	
	if (!headers.hasOwnProperty(headerTitle))
		return;
	
	let props = headers[headerTitle];
	
	cr.arrayFindRemove(props, propertyName);
	
	// Was last property for header: remove header
	if (!props.length)
	{
		delete headers[headerTitle];
		
		// Headers object is now empty: remove entire object record from watch
		if (!cr.hasAnyOwnProperty(headers))
			delete watch[uid.toString()];
	}
};

function OnRemoveFromWatchHeader(headerTitle, displayTitle)
{
	let uid = GetUidFromTitle(displayTitle);
	
	if (!watch.hasOwnProperty(uid.toString()))
		return;
	
	let headers = watch[uid.toString()];
	
	if (headerTitle.charAt(0) === "$")
		headerTitle = headerTitle.substr(1);
	
	if (!headers.hasOwnProperty(headerTitle))
		return;
		
	delete headers[headerTitle];
};

function OnBreakpointUpdate(data)
{
	let eventSheet = data["sheet"];
	let eventNumber = data["eventNumber"];
	let cndIndex = data["cndIndex"];
	let actIndex = data["actIndex"];
	let setBreakpoint = data["isBreakpoint"];
	
	let runtime = window["c3runtime"];
	
	if (!runtime || !runtime.isDebug)
		return;
	
	let sheet = runtime.eventsheets[eventSheet];
	
	if (!sheet)
		return;
	
	let ev = sheet.events_by_number[eventNumber];
	
	if (!ev || !ev.is_breakable)
		return;
	
	if (cndIndex > -1)
	{
		if (ev.conditions && cndIndex < ev.conditions.length)
		{
			ev.conditions[cndIndex].is_breakpoint = setBreakpoint;
			
			console.log((setBreakpoint ? "Set" : "Unset") + " breakpoint at '" + eventSheet + "' event " + eventNumber + " condition " + (cndIndex + 1));
		}
	}
	else if (actIndex > -1)
	{
		if (ev.actions && actIndex < ev.actions.length)
		{
			ev.actions[actIndex].is_breakpoint = setBreakpoint;
			
			console.log((setBreakpoint ? "Set" : "Unset") + " breakpoint at '" + eventSheet + "' event " + eventNumber + " action " + (actIndex + 1));
		}
	}
	else
	{
		// Setting on event block itself
		ev.is_breakpoint = setBreakpoint;
		
		console.log((setBreakpoint ? "Set" : "Unset") + " breakpoint at '" + eventSheet + "' event " + eventNumber);
	}
};

function OnStep()
{
	let runtime = window["c3runtime"];
	if (!runtime)
		return;
	
	if (runtime.hit_breakpoint)
	{
		// Breakpoint step: break again on next block/action/condition
		runtime.step_break = true;
		runtime.debugResume();
	}
	else if (runtime.isSuspended)
	{
		// Ordinary one-tick step
		// Set last tick time to 16ms ago to trick runtime in to setting dt correctly
		runtime.last_tick_time = cr.performance_now() - (1000.0 / 60.0);
		runtime.tick(false, null, true);
	}
};

document.addEventListener("keydown", function(info)
{
	if (info.which === 121)	// F10 to step/next
	{
		OnStep();
		info.preventDefault();
	}		
});
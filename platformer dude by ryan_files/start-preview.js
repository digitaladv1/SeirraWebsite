"use strict";

(function () {
	
	// DOMContentLoaded etc. have fired by this point, so we can go ahead and kick off the runtime.
	// Create the runtime and pass the project data URL left behind by the Init() call.
	window.cr_createRuntime({
		projectDataUrl: window.cr_previewProjectDataUrl,
		exportType: "preview"
	});
	
})();
document.addEventListener("DOMContentLoaded", () => {
    const annotateButton = document.getElementById("annotate");
    const canvas = document.getElementById("annotation-canvas");
    const ctx = canvas.getContext("2d");
    let isDrawing = false;

    annotateButton.addEventListener("click", function () {
        this.classList.toggle("pressed");

        if (this.classList.contains("pressed")) {
            enableDrawing();

        } else {
            disableDrawing();
        }
    });

    function enableDrawing() {
        canvas.style.pointerEvents = "auto";
        canvas.style.cursor = "crosshair";
         
        canvas.addEventListener("mousedown", startDrawing);
        canvas.addEventListener("mousemove", draw);
        canvas.addEventListener("mouseup", stopDrawing);
        
        // Touch event listeners for touchscreen support
        canvas.addEventListener("touchstart", startDrawing, { passive: true });
        canvas.addEventListener("touchmove", draw, { passive: true });
        canvas.addEventListener("touchend", stopDrawing);

        console.log("Drawing mode enabled.");
    }

    function disableDrawing() {
        canvas.style.pointerEvents = "none";
        canvas.style.cursor = "image(''), default";
        canvas.removeEventListener("mousedown", startDrawing);
        canvas.removeEventListener("mousemove", draw);
        canvas.removeEventListener("mouseup", stopDrawing);

        // Remove touch event listeners
        canvas.removeEventListener("touchstart", startDrawing);
        canvas.removeEventListener("touchmove", draw);
        canvas.removeEventListener("touchend", stopDrawing);

        console.log("Drawing mode disabled.");
    }

    // Convert touch events to work like mouse events
    function getTouchPos(evt) {
        const rect = canvas.getBoundingClientRect();
        let x, y;
        if (evt.touches) {
            x = evt.touches[0].clientX - rect.left;
            y = evt.touches[0].clientY - rect.top;
        } else {
            x = evt.clientX - rect.left;
            y = evt.clientY - rect.top;
        }
        return { x, y };
    }
    

    // Start drawing
    function startDrawing(evt) {
        isDrawing = true;
        const pos = getTouchPos(evt);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    }

    // Draw on canvas
    function draw(evt) {
        if (!isDrawing) return;
        evt.preventDefault(); // Prevent scrolling on touch devices
        const pos = getTouchPos(evt);
        ctx.lineTo(pos.x, pos.y);
        ctx.strokeStyle = "red";
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Stop drawing
    function stopDrawing() {
        isDrawing = false;
    }
});

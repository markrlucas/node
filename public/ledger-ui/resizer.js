function resizableGrid(table) {
 var row = table.getElementsByTagName('tr')[0],
   cols = row ? row.children : undefined;
 if (!cols) return;

 table.style.overflow = 'hidden';

 var tableHeight = table.offsetHeight;

 for (var i = 0; i < cols.length; i++) {
  var div = createDiv(tableHeight);
  cols[i].appendChild(div);
  cols[i].style.position = 'relative';
  setListeners(div);
 }

 // Add row resizing
 var rows = table.getElementsByTagName('tr');
 for (var i = 0; i < rows.length; i++) {
  var rowDiv = createRowDiv();
  rows[i].appendChild(rowDiv);
  rows[i].style.position = 'relative';
  setRowListeners(rowDiv);
 }

 function setListeners(div) {
  var pageX, curCol, nxtCol, curColWidth, nxtColWidth;

  div.addEventListener('mousedown', function (e) {
   e.stopPropagation();
   curCol = e.target.parentElement;
   nxtCol = curCol.nextElementSibling;
   pageX = e.pageX;

   var padding = paddingDiff(curCol);

   curColWidth = curCol.offsetWidth - padding;
   if (nxtCol)
    nxtColWidth = nxtCol.offsetWidth - padding;
  });

  div.addEventListener('mouseover', function (e) {
   e.target.style.borderRight = '2px solid #0000ff';
  })

  div.addEventListener('mouseout', function (e) {
   e.target.style.borderRight = '';
  })

  document.addEventListener('mousemove', function (e) {
   if (curCol) {
    var diffX = e.pageX - pageX;

    if (nxtCol)
     nxtCol.style.width = (nxtColWidth - (diffX)) + 'px';

    curCol.style.width = (curColWidth + diffX) + 'px';
   }
  });

  document.addEventListener('mouseup', function (e) {
   curCol = undefined;
   nxtCol = undefined;
   pageX = undefined;
   nxtColWidth = undefined;
   curColWidth = undefined
  });
 }

 function setRowListeners(div) {
  var pageY, curRow, curRowHeight;

  div.addEventListener('mousedown', function (e) {
   e.stopPropagation();
   curRow = e.target.parentElement;
   pageY = e.pageY;
   curRowHeight = curRow.offsetHeight;
  });

  div.addEventListener('mouseover', function (e) {
   e.target.style.borderBottom = '2px solid #0000ff';
  });

  div.addEventListener('mouseout', function (e) {
   e.target.style.borderBottom = '';
  });

  document.addEventListener('mousemove', function (e) {
   if (curRow) {
    var diffY = e.pageY - pageY;
    var newHeight = curRowHeight + diffY;
    curRow.style.height = newHeight + 'px';
    
    var cells = curRow.getElementsByClassName('cell-content');
    for(var i = 0; i < cells.length; i++) {
      cells[i].style.maxHeight = newHeight + 'px';
    }
   }
  });

  document.addEventListener('mouseup', function (e) {
   curRow = undefined;
   pageY = undefined;
   curRowHeight = undefined;
  });
 }

 function createDiv(height) {
  var div = document.createElement('div');
  div.style.top = 0;
  div.style.right = 0;
  div.style.width = '5px';
  div.style.position = 'absolute';
  div.style.cursor = 'col-resize';
  div.style.userSelect = 'none';
  div.style.height = height + 'px';
  return div;
 }

 function createRowDiv() {
  var div = document.createElement('div');
  div.style.bottom = 0;
  div.style.left = 0;
  div.style.width = '100%';
  div.style.position = 'absolute';
  div.style.cursor = 'row-resize';
  div.style.userSelect = 'none';
  div.style.height = '5px';
  return div;
 }

 function paddingDiff(col) {
  if (getStyleVal(col, 'box-sizing') == 'border-box') {
   return 0;
  }

  var padLeft = getStyleVal(col, 'padding-left');
  var padRight = getStyleVal(col, 'padding-right');
  return parseInt(padLeft) + parseInt(padRight);
 }

 function getStyleVal(elm, css) {
  return (window.getComputedStyle(elm, null).getPropertyValue(css))
 }
};

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Splitwise')
      .addItem('Update Month','updateExpenses')
      .addItem('Update All','updateExpensesAll')
      .addToUi();
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function hasServiceAccess() {
  const service = getSplitwiseService();
  if (service.hasAccess()) { return true; }

  const page = HtmlService.createHtmlOutput(
    `<a href="${service.getAuthorizationUrl()}" target="_blank">Authorize Splitwise</a>` +
    ' for this spreadsheet and try again');
  SpreadsheetApp.getUi().showModalDialog(page, 'Authorize Splitwise');
  return false;
}

function updateExpenses() {
  if (!hasServiceAccess()) return;

  const sheet = SpreadsheetApp.getActiveSheet();
  return updateExpensesSheet(sheet);
}

function updateExpensesAll() {
  if (!hasServiceAccess()) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var name of monthNames) {
    var sheet = ss.getSheetByName(name);
    updateExpensesSheet(sheet);
  }
}

function updateExpensesSheet(sheet) {
  var categories = getCategories();
  var tripGroupsIds = getTripGroupsIds();
  var currentUserId = getCurrentUserId();
  var expenses = getSheetExpenses(sheet);
  var filteredExpenses = filterExpenses(expenses, currentUserId, categories, tripGroupsIds);
  var sortedExpenses = sortExpenses(filteredExpenses);
  exportExpenses(sheet, sortedExpenses);
}

function filterExpenses(expenses, currentUserId, categories, tripGroupsIds) {
  var expensesToReturn = [];
  for (i = 0; i < expenses.length; i++) {
    var fullExpense = expenses[i];
    if (fullExpense.deleted_at != null || fullExpense.payment == true || fullExpense.category.id == 18) { continue; }
   
    var users = fullExpense.users;
    var cost = null;
    for (j = 0; j < users.length; j++) {
      if (users[j].user.id == currentUserId) {
        cost = users[j].owed_share;
      }
    }
    if (cost == null || cost == 0) { continue; }
  
    var expense = {
      date: new Date(fullExpense.date),
      description: fullExpense.description,
      category: categories[fullExpense.category.id].category,
      subcategory: categories[fullExpense.category.id].subcategory,
      cost: cost,
      currency: fullExpense.currency_code
    };
    var tripAwareExpense = markAsTripIfNeeded(fullExpense, expense, tripGroupsIds);
    expensesToReturn.push(tripAwareExpense);
  }
  return expensesToReturn;
}

function markAsTripIfNeeded(fullExpense, expense, tripGroupsIds) {
  if (tripGroupsIds.indexOf(fullExpense.group_id) > -1) {
    expense.category = "Entertainment";
    expense.subcategory = "Trips";
  }
  return expense;
}

function sortExpenses(expenses) {
  return expenses.sort(function(a,b) { return new Date(a.date) - new Date(b.date); });
}

function exportExpenses(sheet, expenses) {
  const allCells = sheet.getRange(3, 1, 197, 5);
  allCells.clearContent();
  allCells.setBackground("white");
  if (!expenses.length) return;
  const currencyFormat = configSheet.getRange(3, 4).getValue() || '##0.00';
  sheet.getRangeList(["E3:E", "J3:J", "L3:16", "O3:16", "R3:16", "U16"]).setNumberFormat(currencyFormat);
  const userCurrency = configSheet.getRange(2, 4).getValue();
  const locale = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetLocale();
  const useCommaNumberSep = useCommaDecimalSep(locale);
  const firstCell = 3;
  const expenseRows = [];
  const noteRows = [];
  for (const [i, expense] of expenses.entries()) {
    var cost = expense.cost;
    if (useCommaNumberSep) {
      // Fix number format for spreadhseet locale.
      cost = cost.replace('.', ',');
    }
    if (expense.currency == userCurrency) {
      noteRows.push([null]);
    } else {
      noteRows.push([expense.cost + " " + expense.currency]);
      cost = '=Index(GOOGLEFINANCE("CURRENCY:' + expense.currency + userCurrency + '";"price";A' + (firstCell+i) + ');2;2)*' + cost;
    }
    expenseRows.push([expense.date, expense.category, expense.subcategory, expense.description, cost]);
  }
  sheet.getRange(firstCell, 1, expenseRows.length, 5).setValues(expenseRows);
  const costCells =  sheet.getRange(firstCell, 5, noteRows.length, 1);
  costCells.setNotes(noteRows);

  // Wait for formulas to load.
  let values = costCells.getValues().flat();
  while (values.toString().search('Loading') != -1) {
    Utilities.sleep(50);
    values = costCells.getValues().flat();
  }
  // Freeze values.
  costCells.copyTo(costCells, SpreadsheetApp.CopyPasteType.PASTE_VALUES, false);
  // Update notes with currency exchange rate.
  for (let [idx, [note]] of noteRows.entries()) {
    if (note == null) continue;
    let rate = values[idx] / expenses[idx].cost;
    noteRows[idx][0] += ` * ${rate} ${userCurrency}/${expenses[idx].currency}`;
  }
  costCells.setNotes(noteRows);
}

function getSheetExpenses(sheet) {
  const from = sheet.getRange(1, 21).getValue();
  const to = sheet.getRange(2, 21).getValue();
  try {
    from.setSeconds(from.getSeconds() - 1);
    to.setDate(to.getDate() + 1);
  } catch(e) {
    throw 'Please specify correct date range';
  }
  return getExpenses(from, to);
}

// Splitwise API
function getExpenses(startDate, endDate, limit=500) {
  const expensesPath = `https://secure.splitwise.com/api/v3.0/get_expenses?limit=${limit}&dated_after=${startDate.toJSON()}&dated_before=${endDate.toJSON()}`;
  const expensesResponse = callSplitwiseAPI(expensesPath);
  return expensesResponse.expenses;
}

function getCurrentUserId() {
  const currentUserPath = "https://secure.splitwise.com/api/v3.0/get_current_user";
  const userResponse = callSplitwiseAPI(currentUserPath);
  return userResponse.user.id;
}

function getTripGroupsIds() {
  const groupsPath = "https://secure.splitwise.com/api/v3.0/get_groups";
  const groupsResponse = callSplitwiseAPI(groupsPath);
  
  var tripGroupsIdsToReturn = [];
  for (const group of groupsResponse.groups) {
    if (group.group_type == "trip" || group.group_type == "travel") {
      tripGroupsIdsToReturn.push(group.id);
    }
  }
  return tripGroupsIdsToReturn;
}

function getCategories() {
  const categoriesPath = "https://secure.splitwise.com/api/v3.0/get_categories"; 
  const categoriesResponse = callSplitwiseAPI(categoriesPath);
 
  const categoriesToReturn = [];
  for (const cat of categoriesResponse.categories) {
    for (const subcat of cat.subcategories) {
      categoriesToReturn[subcat.id] = {
        category: cat.name,
        subcategory: subcat.name
      };
    }
  }
  return categoriesToReturn;
}

function callSplitwiseAPI(url, options={}) {
  options.headers = Object.assign({
    Authorization: "OAuth " + getSplitwiseService().getAccessToken(),
  }, options.headers);
  response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

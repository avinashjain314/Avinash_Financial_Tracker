/* app.js - Automation Dashboard Engine */

// Configuration
const CONFIG = {
  salary: {
    spreadsheetId: '1WLUQCxL1VB0seHd9LAnTWK4P3MgGMaYrbTSrBSvVHNk',
    sheetName: 'UPDATED_INCOME'
  },
  expense: {
    spreadsheetId: '1vXGxv98Saw0MfzGOfgB_QBWr9ezMWF1SQyffk2gIyGw',
    sheetName: "Looker's Studio_Update"
  },
  cacheKey: 'dashboard_financial_data',
  cacheExpiryMs: 3600000 // 1 hour
};

// Global App State
const state = {
  salaryData: [],
  expenseData: [],
  filteredSalary: [],
  filteredExpense: [],
  latestDate: new Date(),
  currentTab: 'overview',
  filters: {
    timeRange: 'all',
    salaryStream: 'all',
    expenseCategory: 'all',
    expenseType: 'all'
  },
  search: {
    salary: '',
    expense: ''
  },
  pagination: {
    salary: { page: 1, limit: 10 },
    expense: { page: 1, limit: 10 }
  },
  sort: {
    salary: { field: 'date', asc: false },
    expense: { field: 'date', asc: false }
  },
  targets: {
    budget: Number(localStorage.getItem('target_budget')) || 50000,
    savingsRate: Number(localStorage.getItem('target_savings_rate')) || 30,
    savingsGoal: Number(localStorage.getItem('target_savings_goal')) || 500000
  },
  apiScriptUrl: 'https://script.google.com/macros/s/AKfycbzi3pqCjBnthJJ0nscaVJemPwYrvV5JOIQGLakV_k13xHoe8Kb63uexBdJRRw5HkUNM/exec',
  sessionSubmissions: [],
  charts: {}
};

// Helper: Parse Google Sheets date formats (e.g., "Date(2025,1,25)")
function parseGoogleDate(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string' && dateVal.startsWith('Date(')) {
    const match = dateVal.match(/Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/);
    if (match) {
      // Month is 0-indexed in Google Sheets Date(y, m, d) matching JS exactly
      return new Date(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] ? Number(match[4]) : 0,
        match[5] ? Number(match[5]) : 0,
        match[6] ? Number(match[6]) : 0
      );
    }
  }
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? null : d;
}

// Helper: Format values
const formatter = {
  currency: (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(val),
  percent: (val) => `${val.toFixed(1)}%`,
  date: (dateObj) => {
    if (!dateObj) return '';
    const d = dateObj.getDate().toString().padStart(2, '0');
    const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const y = dateObj.getFullYear();
    return `${d}/${m}/${y}`;
  },
  monthYear: (dateObj) => {
    if (!dateObj) return '';
    return dateObj.toLocaleString('en-US', { month: 'short', year: '2-digit' });
  },
  monthKey: (dateObj) => {
    if (!dateObj) return '';
    const y = dateObj.getFullYear();
    const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    return `${y}-${m}`;
  }
};

// Core: Dynamic JSONP Loader
function fetchSheetJSONP(spreadsheetId, sheetName, callbackName) {
  return new Promise((resolve, reject) => {
    window[callbackName] = function(response) {
      delete window[callbackName];
      const script = document.getElementById(callbackName + '_script');
      if (script) script.remove();
      resolve(response);
    };

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=responseHandler:${callbackName}&sheet=${encodeURIComponent(sheetName)}`;
    const script = document.createElement('script');
    script.id = callbackName + '_script';
    script.src = url;
    script.onerror = () => {
      delete window[callbackName];
      script.remove();
      reject(new Error(`Failed to load sheet: ${sheetName}`));
    };
    document.body.appendChild(script);
  });
}

// Fetch and load data
async function loadData(forceRefresh = false) {
  showLoader(true, 'Initializing...');
  
  if (!forceRefresh) {
    const cached = localStorage.getItem(CONFIG.cacheKey);
    if (cached) {
      try {
        const cacheData = JSON.parse(cached);
        const age = Date.now() - cacheData.timestamp;
        if (age < CONFIG.cacheExpiryMs) {
          console.log('Loading from cache, age:', (age / 1000).toFixed(0) + 's');
          
          // Re-hydrate dates
          state.salaryData = cacheData.salaryData.map(d => ({ ...d, date: new Date(d.date), monthDate: new Date(d.monthDate) }));
          state.expenseData = cacheData.expenseData.map(d => ({ ...d, date: new Date(d.date) }));
          
          updateSyncTime(new Date(cacheData.timestamp));
          processData();
          showLoader(false);
          // Trigger a background silent sync to keep it up to date
          triggerBackgroundSync();
          return;
        }
      } catch (e) {
        console.warn('Cache read error. Fetching fresh data.', e);
      }
    }
  }

  await performFreshFetch();
}

async function performFreshFetch() {
  try {
    showLoader(true, 'Connecting to Google Sheets...');
    const [salaryResponse, expenseResponse] = await Promise.all([
      fetchSheetJSONP(CONFIG.salary.spreadsheetId, CONFIG.salary.sheetName, 'handleSalaryResponse'),
      fetchSheetJSONP(CONFIG.expense.spreadsheetId, CONFIG.expense.sheetName, 'handleExpenseResponse')
    ]);

    showLoader(true, 'Parsing transactions...');
    
    // Parse Salary
    if (salaryResponse.status === 'ok') {
      const rows = salaryResponse.table.rows || [];
      state.salaryData = rows.map(r => {
        const cells = r.c || [];
        const rawDate = cells[0] ? cells[0].v : null;
        const stream = cells[2] ? cells[2].v : 'Unknown';
        const amount = cells[3] ? Number(cells[3].v || 0) : 0;
        const rawMonthDate = cells[4] ? cells[4].v : null;
        
        const date = parseGoogleDate(rawDate);
        const monthDate = parseGoogleDate(rawMonthDate) || date;
        
        return {
          date,
          stream: stream ? String(stream).trim() : 'Unknown',
          amount,
          monthDate
        };
      }).filter(item => item.date !== null && item.amount > 0);
    } else {
      throw new Error('Salary Sheet fetch returned status: ' + salaryResponse.status);
    }

    // Parse Expenses
    if (expenseResponse.status === 'ok') {
      const rows = expenseResponse.table.rows || [];
      state.expenseData = rows.map(r => {
        const cells = r.c || [];
        const rawDate = cells[0] ? cells[0].v : null;
        const expense = cells[2] ? Number(cells[2].v || 0) : 0;
        const category = cells[3] ? cells[3].v : 'Uncategorized';
        const description = cells[4] ? cells[4].v : 'NA';
        const type = cells[5] ? cells[5].v : 'Non Essential';
        
        const date = parseGoogleDate(rawDate);
        
        return {
          date,
          amount: expense,
          category: category ? String(category).trim() : 'Uncategorized',
          description: description ? String(description).trim() : 'NA',
          type: type ? String(type).trim() : 'Non Essential'
        };
      }).filter(item => item.date !== null && item.amount > 0);
    } else {
      throw new Error('Expense Sheet fetch returned status: ' + expenseResponse.status);
    }

    // Cache to localStorage
    const now = Date.now();
    localStorage.setItem(CONFIG.cacheKey, JSON.stringify({
      salaryData: state.salaryData,
      expenseData: state.expenseData,
      timestamp: now
    }));
    
    updateSyncTime(new Date(now));
    processData();
    showLoader(false);
  } catch (error) {
    console.error('Error fetching data:', error);
    showLoader(true, `<span style="color: var(--accent-expense)">Sync Error</span>`, true);
  }
}

// Background sync
async function triggerBackgroundSync() {
  const indicator = document.querySelector('.sync-indicator');
  if (indicator) indicator.classList.add('syncing');
  try {
    const [salaryResponse, expenseResponse] = await Promise.all([
      fetchSheetJSONP(CONFIG.salary.spreadsheetId, CONFIG.salary.sheetName, 'handleSalaryResponseBackground'),
      fetchSheetJSONP(CONFIG.expense.spreadsheetId, CONFIG.expense.sheetName, 'handleExpenseResponseBackground')
    ]);
    
    if (salaryResponse.status === 'ok' && expenseResponse.status === 'ok') {
      // Re-parse and update
      const newSal = (salaryResponse.table.rows || []).map(r => {
        const cells = r.c || [];
        const date = parseGoogleDate(cells[0] ? cells[0].v : null);
        return {
          date,
          stream: cells[2] ? String(cells[2].v || 'Unknown').trim() : 'Unknown',
          amount: cells[3] ? Number(cells[3].v || 0) : 0,
          monthDate: parseGoogleDate(cells[4] ? cells[4].v : null) || date
        };
      }).filter(item => item.date !== null && item.amount > 0);

      const newExp = (expenseResponse.table.rows || []).map(r => {
        const cells = r.c || [];
        const date = parseGoogleDate(cells[0] ? cells[0].v : null);
        return {
          date,
          amount: cells[2] ? Number(cells[2].v || 0) : 0,
          category: cells[3] ? String(cells[3].v || 'Uncategorized').trim() : 'Uncategorized',
          description: cells[4] ? String(cells[4].v || 'NA').trim() : 'NA',
          type: cells[5] ? String(cells[5].v || 'Non Essential').trim() : 'Non Essential'
        };
      }).filter(item => item.date !== null && item.amount > 0);

      state.salaryData = newSal;
      state.expenseData = newExp;
      
      const now = Date.now();
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify({
        salaryData: state.salaryData,
        expenseData: state.expenseData,
        timestamp: now
      }));
      
      updateSyncTime(new Date(now));
      processData();
      console.log('Background sync completed successfully.');
    }
  } catch (e) {
    console.warn('Background sync failed:', e);
  } finally {
    if (indicator) indicator.classList.remove('syncing');
  }
}

// Main logic coordinator
function processData() {
  updateLatestDate();
  populateFilterOptions();
  applyFiltersAndSearch();
  renderAllKPIs();
  renderAllCharts();
  renderAllTables();
  generateSmartInsights();
}

// Compute the latest transaction date to base filters on
function updateLatestDate() {
  const dates = [...state.salaryData.map(d => d.date), ...state.expenseData.map(d => d.date)].filter(d => d);
  if (dates.length > 0) {
    state.latestDate = new Date(Math.max(...dates));
  } else {
    state.latestDate = new Date(2026, 7, 11); // default fallback
  }
}

// Populate Category/Stream filters dropdowns
function populateFilterOptions() {
  // Salary Streams
  const streams = new Set(state.salaryData.map(d => d.stream));
  const salSelect = document.getElementById('filter-salary-stream');
  if (salSelect) {
    const currentVal = state.filters.salaryStream;
    salSelect.innerHTML = '<option value="all">All Income Streams</option>';
    Array.from(streams).sort().forEach(s => {
      salSelect.innerHTML += `<option value="${s}" ${currentVal === s ? 'selected' : ''}>${s}</option>`;
    });
  }

  // Expense Categories
  const categories = new Set(state.expenseData.map(d => d.category));
  const expSelect = document.getElementById('filter-expense-category');
  if (expSelect) {
    const currentVal = state.filters.expenseCategory;
    expSelect.innerHTML = '<option value="all">All Categories</option>';
    Array.from(categories).sort().forEach(c => {
      expSelect.innerHTML += `<option value="${c}" ${currentVal === c ? 'selected' : ''}>${c}</option>`;
    });
  }
}

// Helper: Check if date falls in time window
function matchTimeRange(date, range) {
  if (!date) return false;
  if (range === 'all') return true;
  
  const ref = state.latestDate;
  const itemTime = date.getTime();
  
  if (range === 'ytd') {
    return date.getFullYear() === ref.getFullYear();
  } else if (range === '3m') {
    const limit = new Date(ref.getFullYear(), ref.getMonth() - 3, ref.getDate());
    return itemTime >= limit.getTime();
  } else if (range === '6m') {
    const limit = new Date(ref.getFullYear(), ref.getMonth() - 6, ref.getDate());
    return itemTime >= limit.getTime();
  } else if (range === '12m') {
    const limit = new Date(ref.getFullYear(), ref.getMonth() - 12, ref.getDate());
    return itemTime >= limit.getTime();
  }
  return true;
}

// Apply current filter states
function applyFiltersAndSearch() {
  // Apply tab filters
  state.filteredSalary = state.salaryData.filter(item => {
    if (!matchTimeRange(item.date, state.filters.timeRange)) return false;
    if (state.filters.salaryStream !== 'all' && item.stream !== state.filters.salaryStream) return false;
    return true;
  });

  state.filteredExpense = state.expenseData.filter(item => {
    if (!matchTimeRange(item.date, state.filters.timeRange)) return false;
    if (state.filters.expenseCategory !== 'all' && item.category !== state.filters.expenseCategory) return false;
    if (state.filters.expenseType !== 'all' && item.type !== state.filters.expenseType) return false;
    return true;
  });
}

// Render Core KPI Blocks
function renderAllKPIs() {
  // --- Overview Tab ---
  const totalIncome = state.filteredSalary.reduce((acc, curr) => acc + curr.amount, 0);
  const totalExpense = state.filteredExpense.reduce((acc, curr) => acc + curr.amount, 0);
  const netSavings = totalIncome - totalExpense;
  const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;
  
  document.getElementById('ov-income').textContent = formatter.currency(totalIncome);
  document.getElementById('ov-expense').textContent = formatter.currency(totalExpense);
  
  const netVal = document.getElementById('ov-net');
  netVal.textContent = formatter.currency(netSavings);
  if (netSavings >= 0) {
    netVal.style.color = 'var(--accent-salary)';
  } else {
    netVal.style.color = 'var(--accent-expense)';
  }
  
  const rateVal = document.getElementById('ov-rate');
  rateVal.textContent = formatter.percent(savingsRate);
  
  // Progress Bar for savings rate
  const rateProgress = document.getElementById('ov-rate-progress');
  if (rateProgress) {
    const clampedRate = Math.max(0, Math.min(100, savingsRate));
    rateProgress.style.width = `${clampedRate}%`;
    if (savingsRate >= state.targets.savingsRate) {
      rateProgress.style.backgroundColor = 'var(--accent-salary)';
    } else if (savingsRate >= 10) {
      rateProgress.style.backgroundColor = 'var(--accent-net)';
    } else {
      rateProgress.style.backgroundColor = 'var(--accent-expense)';
    }
  }

  // Savings rate target comparison indicator
  const rateGoalEl = document.getElementById('ov-rate-goal');
  if (rateGoalEl) {
    rateGoalEl.innerHTML = `<i class="fa-solid fa-bullseye"></i> Goal: ${state.targets.savingsRate}%`;
    if (savingsRate >= state.targets.savingsRate) {
      rateGoalEl.className = 'kpi-target-indicator met';
      rateGoalEl.innerHTML += ' <span style="font-weight:600;">(Goal Met)</span>';
    } else {
      rateGoalEl.className = 'kpi-target-indicator exceeded';
      rateGoalEl.innerHTML += ' <span style="font-weight:600;">(Below Goal)</span>';
    }
  }

  // --- Salary Tab ---
  document.getElementById('sal-total').textContent = formatter.currency(totalIncome);
  
  // Calculate Avg monthly salary
  const salMonths = new Set(state.filteredSalary.map(d => formatter.monthKey(d.date)));
  const avgSal = salMonths.size > 0 ? totalIncome / salMonths.size : 0;
  document.getElementById('sal-avg').textContent = formatter.currency(avgSal);
  document.getElementById('sal-avg-sub').textContent = `Across ${salMonths.size} active month(s)`;

  // Calculate Current vs Last Month Salary
  let salTodayDate = new Date();
  if (state.salaryData.length > 0) {
    const allSalDates = state.salaryData.map(d => d.date.getTime());
    salTodayDate = new Date(Math.max(...allSalDates));
  }
  const salCurrentMonth = salTodayDate.getMonth();
  const salCurrentYear = salTodayDate.getFullYear();

  let salCurrentMonthSum = 0;
  state.salaryData.forEach(d => {
    if (d.date && d.date.getMonth() === salCurrentMonth && d.date.getFullYear() === salCurrentYear) {
      salCurrentMonthSum += d.amount;
    }
  });

  let salPrevMonth = salCurrentMonth - 1;
  let salPrevYear = salCurrentYear;
  if (salPrevMonth < 0) {
    salPrevMonth = 11;
    salPrevYear = salCurrentYear - 1;
  }

  let salPrevMonthSum = 0;
  state.salaryData.forEach(d => {
    if (d.date && d.date.getMonth() === salPrevMonth && d.date.getFullYear() === salPrevYear) {
      salPrevMonthSum += d.amount;
    }
  });

  const salCurrentMonthEl = document.getElementById('sal-current-month');
  if (salCurrentMonthEl) {
    salCurrentMonthEl.textContent = formatter.currency(salCurrentMonthSum);
  }
  const salCurrentMonthSubEl = document.getElementById('sal-current-month-sub');
  if (salCurrentMonthSubEl) {
    const monthName = salTodayDate.toLocaleDateString([], { month: 'short', year: '2-digit' });
    salCurrentMonthSubEl.textContent = `Earned in ${monthName}`;
  }

  const salMomEl = document.getElementById('sal-current-month-mom');
  if (salMomEl) {
    if (salPrevMonthSum > 0) {
      const pctChange = ((salCurrentMonthSum - salPrevMonthSum) / salPrevMonthSum) * 100;
      const isIncrease = pctChange >= 0;
      const badgeClass = isIncrease ? 'good' : 'bad'; // increase in income is good!
      const arrow = isIncrease ? 'fa-arrow-up' : 'fa-arrow-down';
      const sign = isIncrease ? '+' : '';
      salMomEl.className = `mom-badge ${badgeClass}`;
      salMomEl.innerHTML = `<i class="fa-solid ${arrow}"></i> ${sign}${pctChange.toFixed(1)}% MoM`;
    } else {
      salMomEl.className = 'mom-badge neutral';
      salMomEl.innerHTML = '<i class="fa-solid fa-minus"></i> 0.0% MoM';
    }
  }

  const salLastMonthAmtEl = document.getElementById('sal-last-month-amount');
  if (salLastMonthAmtEl) {
    salLastMonthAmtEl.textContent = `Last Month: ${formatter.currency(salPrevMonthSum)}`;
  }
  
  // Top Stream
  const streamTotals = {};
  state.filteredSalary.forEach(d => {
    streamTotals[d.stream] = (streamTotals[d.stream] || 0) + d.amount;
  });
  let topStream = 'None';
  let topStreamVal = 0;
  Object.keys(streamTotals).forEach(s => {
    if (streamTotals[s] > topStreamVal) {
      topStream = s;
      topStreamVal = streamTotals[s];
    }
  });
  document.getElementById('sal-top').textContent = topStream;
  document.getElementById('sal-top-sub').textContent = topStreamVal > 0 ? `${formatter.currency(topStreamVal)} total` : 'No data';
  
  // Active Sources count
  document.getElementById('sal-count').textContent = Object.keys(streamTotals).length;

  // --- Expenses Tab ---
  document.getElementById('exp-total').textContent = formatter.currency(totalExpense);
  
  // Avg monthly expense
  const expMonths = new Set(state.filteredExpense.map(d => formatter.monthKey(d.date)));
  const avgExp = expMonths.size > 0 ? totalExpense / expMonths.size : 0;
  document.getElementById('exp-avg').textContent = formatter.currency(avgExp);
  document.getElementById('exp-avg-sub').textContent = `Across ${expMonths.size} active month(s)`;
  
  // Essential Ratio
  let essentialSum = 0;
  let nonEssentialSum = 0;
  state.filteredExpense.forEach(d => {
    if (d.type === 'Essential') {
      essentialSum += d.amount;
    } else {
      nonEssentialSum += d.amount;
    }
  });
  const essentialRatio = totalExpense > 0 ? (essentialSum / totalExpense) * 100 : 0;
  document.getElementById('exp-essential').textContent = formatter.percent(essentialRatio);
  document.getElementById('exp-essential-sub').textContent = `${formatter.currency(essentialSum)} Essential vs ${formatter.currency(nonEssentialSum)} Non-Essential`;
  
  const expProgress = document.getElementById('exp-ratio-progress');
  if (expProgress) {
    expProgress.style.width = `${essentialRatio}%`;
    expProgress.style.backgroundColor = 'var(--accent-essential)';
  }

  // Daily Average Spend
  let daysCount = 1;
  const expDates = state.filteredExpense.map(d => d.date.getTime());
  if (expDates.length > 1) {
    const minDate = Math.min(...expDates);
    const maxDate = Math.max(...expDates);
    daysCount = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) || 1;
  }
  const dailyAvg = totalExpense / daysCount;
  document.getElementById('exp-daily').textContent = formatter.currency(dailyAvg);
  document.getElementById('exp-daily-sub').textContent = `Tracked over ${daysCount} days`;

  // --- Day-on-Day Month-to-Date (MTD) Calculations ---
  // 1. Find the latest date in the entire dataset (serves as "today")
  let todayDate = new Date();
  if (state.expenseData.length > 0) {
    const allDates = state.expenseData.map(d => d.date.getTime());
    todayDate = new Date(Math.max(...allDates));
  }
  
  const currentMonth = todayDate.getMonth();
  const currentYear = todayDate.getFullYear();
  const currentDay = todayDate.getDate();

  // 2. Sum current month MTD expenses (up to currentDay)
  let currentMonthMtdSum = 0;
  state.expenseData.forEach(d => {
    if (d.date && d.date.getMonth() === currentMonth && d.date.getFullYear() === currentYear && d.date.getDate() <= currentDay) {
      currentMonthMtdSum += d.amount;
    }
  });

  // 3. Find previous month and year
  let prevMonth = currentMonth - 1;
  let prevYear = currentYear;
  if (prevMonth < 0) {
    prevMonth = 11;
    prevYear = currentYear - 1;
  }

  // 4. Sum previous month MTD expenses (up to same currentDay)
  let prevMonthMtdSum = 0;
  state.expenseData.forEach(d => {
    if (d.date && d.date.getMonth() === prevMonth && d.date.getFullYear() === prevYear && d.date.getDate() <= currentDay) {
      prevMonthMtdSum += d.amount;
    }
  });

  // 5. Populate Current Month Spend values
  const currentMonthSpendEl = document.getElementById('exp-current-month');
  if (currentMonthSpendEl) {
    currentMonthSpendEl.textContent = formatter.currency(currentMonthMtdSum);
  }

  // Set the subtitle to show the date range
  const currentMonthSubEl = document.getElementById('exp-current-month-sub');
  if (currentMonthSubEl) {
    const monthName = todayDate.toLocaleDateString([], { month: 'short', year: '2-digit' });
    currentMonthSubEl.textContent = `Spent in ${monthName} (up to Day ${currentDay})`;
  }

  // 6. Day-on-Day MoM % change badge
  const currentMonthMomEl = document.getElementById('exp-current-month-mom');
  if (currentMonthMomEl) {
    if (prevMonthMtdSum > 0) {
      const pctChange = ((currentMonthMtdSum - prevMonthMtdSum) / prevMonthMtdSum) * 100;
      const isIncrease = pctChange >= 0;
      const badgeClass = isIncrease ? 'bad' : 'good'; // increase in spend is bad, decrease is good!
      const arrow = isIncrease ? 'fa-arrow-up' : 'fa-arrow-down';
      const sign = isIncrease ? '+' : '';
      
      const prevMonthName = new Date(prevYear, prevMonth, 1).toLocaleDateString([], { month: 'short', year: '2-digit' });
      
      currentMonthMomEl.className = `mom-badge ${badgeClass}`;
      currentMonthMomEl.innerHTML = `<i class="fa-solid ${arrow}"></i> ${sign}${pctChange.toFixed(1)}% vs same MTD in ${prevMonthName}`;
    } else {
      currentMonthMomEl.className = 'mom-badge neutral';
      currentMonthMomEl.innerHTML = '<i class="fa-solid fa-minus"></i> N/A MTD';
    }
  }

  // 7. Budget target status comparison for current month
  const budgetStatusEl = document.getElementById('exp-target-status');
  if (budgetStatusEl) {
    budgetStatusEl.innerHTML = `<i class="fa-solid fa-bullseye"></i> Budget: ${formatter.currency(state.targets.budget)}`;
    if (currentMonthMtdSum <= state.targets.budget) {
      budgetStatusEl.className = 'kpi-target-indicator met';
      budgetStatusEl.innerHTML += ` <span style="font-weight:600;">(On Track)</span>`;
    } else {
      budgetStatusEl.className = 'kpi-target-indicator exceeded';
      budgetStatusEl.innerHTML += ` <span style="font-weight:600;">(Over by ${formatter.currency(currentMonthMtdSum - state.targets.budget)})</span>`;
    }
  }

  // 8. Calculate and populate Last Month's full expenses total
  let expPrevMonthFullSum = 0;
  state.expenseData.forEach(d => {
    if (d.date && d.date.getMonth() === prevMonth && d.date.getFullYear() === prevYear) {
      expPrevMonthFullSum += d.amount;
    }
  });

  const expLastMonthEl = document.getElementById('exp-last-month');
  if (expLastMonthEl) {
    expLastMonthEl.textContent = formatter.currency(expPrevMonthFullSum);
  }

  const expLastMonthSubEl = document.getElementById('exp-last-month-sub');
  if (expLastMonthSubEl) {
    const prevMonthDate = new Date(prevYear, prevMonth, 1);
    const prevMonthName = prevMonthDate.toLocaleDateString([], { month: 'short', year: '2-digit' });
    expLastMonthSubEl.textContent = `Total spent in ${prevMonthName}`;
  }

  const expLastMonthCompareEl = document.getElementById('exp-last-month-compare');
  if (expLastMonthCompareEl) {
    const diff = currentMonthMtdSum - expPrevMonthFullSum;
    const diffStr = diff >= 0 ? `+${formatter.currency(diff)}` : `-${formatter.currency(Math.abs(diff))}`;
    expLastMonthCompareEl.textContent = `${diff >= 0 ? 'Exceeded' : 'Under'} last month by ${formatter.currency(Math.abs(diff))}`;
    expLastMonthCompareEl.style.color = diff >= 0 ? 'var(--accent-expense)' : 'var(--accent-salary)';
  }
}

// Generate Automated Financial Insights
function generateSmartInsights() {
  const container = document.getElementById('insights-container');
  if (!container) return;

  const insights = [];

  // Insight 1: Savings Rate Analysis
  const totalIncome = state.filteredSalary.reduce((acc, curr) => acc + curr.amount, 0);
  const totalExpense = state.filteredExpense.reduce((acc, curr) => acc + curr.amount, 0);
  const netSavings = totalIncome - totalExpense;
  const savingsRate = totalIncome > 0 ? (netSavings / totalIncome) * 100 : 0;

  if (totalIncome > 0) {
    if (savingsRate >= 35) {
      insights.push({
        title: 'High Savings Rate',
        text: `Your savings rate is strong at ${formatter.percent(savingsRate)}. You have retained ${formatter.currency(netSavings)} from your total income, indicating excellent budget management.`,
        type: 'savings',
        icon: 'fa-vault'
      });
    } else if (savingsRate >= 15) {
      insights.push({
        title: 'Healthy Savings Buffer',
        text: `You saved ${formatter.percent(savingsRate)} (${formatter.currency(netSavings)}) of your earnings. Keeping this above 20% will build long-term wealth quickly.`,
        type: 'savings',
        icon: 'fa-piggy-bank'
      });
    } else if (savingsRate >= 0) {
      insights.push({
        title: 'Low Cash Accumulation',
        text: `Your savings rate is ${formatter.percent(savingsRate)}. You saved only ${formatter.currency(netSavings)} in this period. Review your Non-Essential category expenses to find savings opportunities.`,
        type: 'warning',
        icon: 'fa-circle-exclamation'
      });
    } else {
      insights.push({
        title: 'Budget Deficit Alert',
        text: `Your spending exceeded income by ${formatter.currency(Math.abs(netSavings))} (Savings rate: ${formatter.percent(savingsRate)}). You are operating on a deficit during this period!`,
        type: 'warning',
        icon: 'fa-triangle-exclamation'
      });
    }
  }

  // Insight 2: Top Expense Category
  const categoryTotals = {};
  state.filteredExpense.forEach(d => {
    categoryTotals[d.category] = (categoryTotals[d.category] || 0) + d.amount;
  });
  
  let topCat = 'None';
  let topCatVal = 0;
  Object.keys(categoryTotals).forEach(c => {
    if (categoryTotals[c] > topCatVal) {
      topCat = c;
      topCatVal = categoryTotals[c];
    }
  });

  if (totalExpense > 0 && topCatVal > 0) {
    const pct = (topCatVal / totalExpense) * 100;
    let text = `Your top expense is **${topCat}** at ${formatter.currency(topCatVal)} (${formatter.percent(pct)} of total spending).`;
    if (pct > 30 && ['Essential', 'Rent', 'FLAT_Security'].indexOf(topCat) === -1) {
      text += ` This category represents a significant portion of your expenses. Consider if some of this is discretionary.`;
    }
    insights.push({
      title: `Dominant Category: ${topCat}`,
      text: text,
      type: 'expense',
      icon: 'fa-wallet'
    });
  }

  // Insight 3: Essential vs Non-Essential spending
  let essentialSum = 0;
  state.filteredExpense.forEach(d => {
    if (d.type === 'Essential') essentialSum += d.amount;
  });
  
  if (totalExpense > 0) {
    const essentialPct = (essentialSum / totalExpense) * 100;
    const nonEssentialPct = 100 - essentialPct;
    if (nonEssentialPct > 50) {
      insights.push({
        title: 'High Discretionary Outflow',
        text: `Over half of your expenses (${formatter.percent(nonEssentialPct)}) go to **Non-Essential** items. The standard 50/30/20 budget recommends keeping wants below 30% of net income.`,
        type: 'warning',
        icon: 'fa-chart-pie'
      });
    } else {
      insights.push({
        title: 'Excellent Essential Balance',
        text: `Your budget is lean with **Essential** expenses accounting for ${formatter.percent(essentialPct)} and Non-Essential at ${formatter.percent(nonEssentialPct)}. This is highly optimal.`,
        type: 'savings',
        icon: 'fa-scale-balanced'
      });
    }
  }

  // Insight 4: Income Streams Distribution
  const streamTotals = {};
  state.filteredSalary.forEach(d => {
    streamTotals[d.stream] = (streamTotals[d.stream] || 0) + d.amount;
  });
  let topStream = 'None';
  let topStreamVal = 0;
  Object.keys(streamTotals).forEach(s => {
    if (streamTotals[s] > topStreamVal) {
      topStream = s;
      topStreamVal = streamTotals[s];
    }
  });

  if (totalIncome > 0 && topStreamVal > 0) {
    const streamPct = (topStreamVal / totalIncome) * 100;
    insights.push({
      title: `Main Income: ${topStream}`,
      text: `Your top income source is **${topStream}** which brings in ${formatter.currency(topStreamVal)} (${formatter.percent(streamPct)} of total earnings). You have ${Object.keys(streamTotals).length} distinct revenue stream(s).`,
      type: 'income',
      icon: 'fa-money-bill-trend-up'
    });
  }

  // Insight: Savings Goal Tracker & Real-life Financial Recommendations
  const allTimeIncomeVal = state.salaryData.reduce((acc, curr) => acc + curr.amount, 0);
  const allTimeExpenseVal = state.expenseData.reduce((acc, curr) => acc + curr.amount, 0);
  const accumulatedSavings = allTimeIncomeVal - allTimeExpenseVal;
  
  // Calculate average monthly savings
  const monthKeysSet = new Set();
  state.salaryData.forEach(d => monthKeysSet.add(formatter.monthKey(d.date)));
  state.expenseData.forEach(d => monthKeysSet.add(formatter.monthKey(d.date)));
  const totalActiveMonths = Math.max(1, monthKeysSet.size);
  const avgMonthlySavings = accumulatedSavings / totalActiveMonths;

  const targetGoal = state.targets.savingsGoal;
  const progressPct = Math.min(100, Math.max(0, (accumulatedSavings / targetGoal) * 100));

  let goalText = "";
  let goalTitle = "Savings Goal Target Progress";
  let goalIcon = "fa-bullseye";
  let goalType = "savings";

  if (accumulatedSavings >= targetGoal) {
    goalTitle = "🎯 Savings Target Achieved!";
    goalText = `Outstanding! You have accumulated **${formatter.currency(accumulatedSavings)}** in total savings, surpassing your target of **${formatter.currency(targetGoal)}**! Your next step is to invest this surplus to outpace inflation.`;
  } else {
    const remainingToSave = targetGoal - accumulatedSavings;
    goalTitle = `Savings Goal: ${Math.round(progressPct)}% Achieved`;
    
    if (avgMonthlySavings > 0) {
      const monthsToReach = remainingToSave / avgMonthlySavings;
      const targetMonthDate = new Date();
      targetMonthDate.setMonth(targetMonthDate.getMonth() + Math.ceil(monthsToReach));
      const targetMonthStr = targetMonthDate.toLocaleDateString([], { month: 'long', year: 'numeric' });
      
      goalText = `You have saved **${formatter.currency(accumulatedSavings)}** of your **${formatter.currency(targetGoal)}** goal. At your historical average savings rate of **${formatter.currency(avgMonthlySavings)}/month**, you are on track to achieve this target in **${Math.ceil(monthsToReach)} months** (${targetMonthStr}).`;
      
      // Add actionable recommendation
      const topExpenseCategoriesSorted = Object.entries(categoryTotals).sort((a,b) => b[1] - a[1]);
      if (topExpenseCategoriesSorted.length > 0) {
        const primaryCatName = topExpenseCategoriesSorted[0][0];
        const primaryCatVal = topExpenseCategoriesSorted[0][1];
        if (primaryCatName !== 'Rent' && primaryCatName !== 'FLAT_Security') {
          const cutPotential = primaryCatVal * 0.15;
          const fasterMonths = remainingToSave / (avgMonthlySavings + cutPotential);
          const monthsSaved = Math.ceil(monthsToReach) - Math.ceil(fasterMonths);
          if (monthsSaved > 0) {
            goalText += `<br><br><i class="fa-solid fa-lightbulb" style="color: var(--accent-salary); margin-right: 4px;"></i> **AI Recommendation**: Reducing discretionary **${primaryCatName}** spending by just 15% would save an extra **${formatter.currency(cutPotential)}/month** and let you achieve your goal **${monthsSaved} month${monthsSaved > 1 ? 's' : ''} faster**!`;
          }
        }
      }
    } else {
      goalText = `You have saved **${formatter.currency(accumulatedSavings)}** of your **${formatter.currency(targetGoal)}** goal. You are currently operating at a net financial deficit. Cut non-essential outlays immediately to establish a positive savings rate.`;
      goalType = "warning";
      goalIcon = "fa-circle-exclamation";
    }
  }

  insights.unshift({
    title: goalTitle,
    text: goalText,
    type: goalType,
    icon: goalIcon
  });

  // Render insights list
  if (insights.length === 0) {
    container.innerHTML = '<p class="text-muted">No insights available for this period. Try clearing your filters.</p>';
  } else {
    container.innerHTML = '';
    insights.forEach(ins => {
      const card = document.createElement('div');
      card.className = 'insight-item';
      card.innerHTML = `
        <div class="insight-icon ${ins.type}">
          <i class="fa-solid ${ins.icon}"></i>
        </div>
        <div class="insight-text">
          <h4>${ins.title}</h4>
          <p>${ins.text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</p>
        </div>
      `;
      container.appendChild(card);
    });
  }
}

// Generate chronologically sorted monthly aggregated datasets
function getMonthlyAggregatedData() {
  const data = {};

  // Aggregate Salary
  state.filteredSalary.forEach(item => {
    const key = formatter.monthKey(item.date);
    const label = formatter.monthYear(item.date);
    if (!data[key]) {
      data[key] = { key, label, income: 0, expense: 0, essential: 0, nonessential: 0 };
    }
    data[key].income += item.amount;
  });

  // Aggregate Expenses
  state.filteredExpense.forEach(item => {
    const key = formatter.monthKey(item.date);
    const label = formatter.monthYear(item.date);
    if (!data[key]) {
      data[key] = { key, label, income: 0, expense: 0, essential: 0, nonessential: 0 };
    }
    data[key].expense += item.amount;
    if (item.type === 'Essential') {
      data[key].essential += item.amount;
    } else {
      data[key].nonessential += item.amount;
    }
  });

  // Sort chronologically by YYYY-MM key
  return Object.keys(data).sort().map(k => data[k]);
}

// Modal Drilldown logic for "Others" categories
let lastClick = { time: 0, index: -1, chart: '' };

function handleChartDoubleClick(chartKey, index, label) {
  const now = Date.now();
  if (lastClick.chart === chartKey && lastClick.index === index && (now - lastClick.time) < 350) {
    // Double click detected!
    if (label === 'Others' || label === 'Others (Dormant)') {
      openOthersModal(chartKey);
    }
  }
  lastClick = { time: now, index: index, chart: chartKey };
}

function openOthersModal(type) {
  const modal = document.getElementById('breakdown-modal');
  const title = document.getElementById('modal-title');
  const colName = document.getElementById('modal-col-name');
  const tbody = document.getElementById('modal-table-body');
  
  if (!modal || !tbody) return;
  
  tbody.innerHTML = '';
  
  if (type === 'salary') {
    title.textContent = 'Breakdown of Dormant Salary Streams';
    colName.textContent = 'Salary Stream';
    
    // Find dormant streams (ceased on or before Jan 31, 2026)
    const streamLastDates = {};
    state.salaryData.forEach(d => {
      if (d.date) {
        if (!streamLastDates[d.stream] || d.date > streamLastDates[d.stream]) {
          streamLastDates[d.stream] = d.date;
        }
      }
    });
    
    const dormantThreshold = new Date(2026, 0, 31);
    const dormantSums = {};
    
    state.filteredSalary.forEach(d => {
      const isDormant = streamLastDates[d.stream] ? (streamLastDates[d.stream] <= dormantThreshold) : true;
      if (isDormant) {
        dormantSums[d.stream] = (dormantSums[d.stream] || 0) + d.amount;
      }
    });
    
    const sorted = Object.keys(dormantSums).sort((a, b) => dormantSums[b] - dormantSums[a]);
    sorted.forEach(stream => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${stream}</td>
        <td style="text-align: right; font-weight: 600; color: var(--accent-salary);">${formatter.currency(Math.round(dormantSums[stream]))}</td>
      `;
      tbody.appendChild(row);
    });
  } else {
    title.textContent = 'Breakdown of Other Spending Categories';
    colName.textContent = 'Expense Category';
    
    // Find categories outside the Top 15
    const catsMap = {};
    state.filteredExpense.forEach(d => {
      catsMap[d.category] = (catsMap[d.category] || 0) + d.amount;
    });
    
    const sortedCats = Object.keys(catsMap).sort((a, b) => catsMap[b] - catsMap[a]);
    const topCount = 15;
    const otherCats = sortedCats.slice(topCount);
    
    otherCats.forEach(cat => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${cat}</td>
        <td style="text-align: right; font-weight: 600; color: var(--accent-expense);">${formatter.currency(Math.round(catsMap[cat]))}</td>
      `;
      tbody.appendChild(row);
    });
    
    if (otherCats.length === 0) {
      tbody.innerHTML = '<tr><td colspan="2" style="text-align: center; color: var(--text-muted); padding: 20px;">No other categories hidden.</td></tr>';
    }
  }
  
  modal.style.display = 'flex';
  setTimeout(() => {
    modal.classList.add('show');
  }, 10);
}

function closeOthersModal() {
  const modal = document.getElementById('breakdown-modal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);
  }
}

// Render ApexCharts Visuals
function renderAllCharts() {
  const monthlyData = getMonthlyAggregatedData();
  const months = monthlyData.map(d => d.label);

  // Destroy previous charts to re-render fresh
  Object.keys(state.charts).forEach(key => {
    if (state.charts[key] && typeof state.charts[key].destroy === 'function') {
      state.charts[key].destroy();
    }
  });
  state.charts = {};

  // Common Apex Theme Config
  const baseChartOptions = {
    chart: {
      foreColor: '#94a3b8',
      toolbar: { show: false },
      background: 'transparent'
    },
    grid: {
      borderColor: 'rgba(255, 255, 255, 0.05)',
      strokeDashArray: 4
    },
    tooltip: {
      theme: 'dark',
      y: {
        formatter: (val) => formatter.currency(Math.round(val))
      }
    }
  };

  // ==========================================
  // CHART 1: Overview - Income vs Expense (Grouped Bar)
  // ==========================================
  const cashflowEl = document.getElementById('chart-cashflow');
  if (cashflowEl && state.currentTab === 'overview') {
    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        height: 320
      },
      colors: ['#10b981', '#f43f5e'],
      series: [
        { name: 'Income', data: monthlyData.map(d => d.income) },
        { name: 'Expense', data: monthlyData.map(d => d.expense) }
      ],
      xaxis: {
        categories: months
      },
      dataLabels: {
        enabled: true,
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        offsetY: -20,
        formatter: function(val) {
          if (!val) return '';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(0) + 'K' : 
                 val.toString();
        }
      },
      plotOptions: {
        bar: {
          horizontal: false,
          columnWidth: '55%',
          borderRadius: 4,
          dataLabels: {
            position: 'top'
          }
        }
      },
      stroke: {
        show: true,
        width: 2,
        colors: ['transparent']
      },
      fill: { opacity: 0.95 },
      yaxis: {
        labels: {
          formatter: (v) => formatter.currency(v)
        }
      }
    };
    state.charts.cashflow = new ApexCharts(cashflowEl, options);
    state.charts.cashflow.render();
  }

  // ==========================================
  // CHART 2: Overview - Cumulative Net Savings (Area)
  // ==========================================
  const networthEl = document.getElementById('chart-networth');
  if (networthEl && state.currentTab === 'overview') {
    let cumulative = 0;
    const cumulativeSavings = monthlyData.map(d => {
      cumulative += (d.income - d.expense);
      return cumulative;
    });

    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'area',
        height: 320
      },
      colors: ['#6366f1'],
      series: [{ name: 'Cumulative Savings', data: cumulativeSavings }],
      xaxis: {
        categories: months
      },
      dataLabels: { enabled: false },
      stroke: {
        curve: 'smooth',
        width: 3
      },
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 1,
          opacityFrom: 0.45,
          opacityTo: 0.05,
          stops: [0, 100]
        }
      },
      yaxis: {
        labels: {
          formatter: (v) => formatter.currency(v)
        }
      }
    };
    state.charts.networth = new ApexCharts(networthEl, options);
    state.charts.networth.render();
  }

  // ==========================================
  // CHART 3: Salary - Monthly Trends (Bar)
  // ==========================================
  const salTrendEl = document.getElementById('chart-salary-trend');
  if (salTrendEl && state.currentTab === 'salary') {
    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        height: 320
      },
      colors: ['#10b981'],
      series: [{ name: 'Monthly Income', data: monthlyData.map(d => d.income) }],
      xaxis: {
        categories: months
      },
      dataLabels: {
        enabled: true,
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        offsetY: -20,
        formatter: function(val) {
          if (!val) return '';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(0) + 'K' : 
                 val.toString();
        }
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          columnWidth: '50%',
          dataLabels: {
            position: 'top'
          }
        }
      },
      yaxis: {
        labels: {
          formatter: (v) => formatter.currency(v)
        }
      }
    };
    state.charts.salaryTrend = new ApexCharts(salTrendEl, options);
    state.charts.salaryTrend.render();
  }

  // ==========================================
  // CHART 4: Salary - Stream Distribution (Donut)
  // ==========================================
  const salDistEl = document.getElementById('chart-salary-dist');
  if (salDistEl && state.currentTab === 'salary') {
    // Determine last transaction date for each stream to identify dormant streams
    const streamLastDates = {};
    state.salaryData.forEach(d => {
      if (d.date) {
        if (!streamLastDates[d.stream] || d.date > streamLastDates[d.stream]) {
          streamLastDates[d.stream] = d.date;
        }
      }
    });

    const dormantThreshold = new Date(2026, 0, 31); // Jan 31, 2026

    const streamsMap = {};
    let dormantSum = 0;

    state.filteredSalary.forEach(d => {
      const isDormant = streamLastDates[d.stream] ? (streamLastDates[d.stream] <= dormantThreshold) : true;
      if (isDormant) {
        dormantSum += d.amount;
      } else {
        streamsMap[d.stream] = (streamsMap[d.stream] || 0) + d.amount;
      }
    });

    const activeStreams = Object.keys(streamsMap).sort((a, b) => streamsMap[b] - streamsMap[a]);
    const series = activeStreams.map(s => Math.round(streamsMap[s]));
    const labels = [...activeStreams];

    if (dormantSum > 0) {
      series.push(Math.round(dormantSum));
      labels.push('Others (Dormant)');
    }

    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        height: 340,
        events: {
          dataPointSelection: function(event, chartContext, config) {
            if (config.dataPointIndex !== undefined && config.dataPointIndex !== -1) {
              const label = config.w.config.xaxis.categories[config.dataPointIndex];
              handleChartDoubleClick('salary', config.dataPointIndex, label);
            }
          }
        }
      },
      colors: ['#10b981'],
      series: [{ name: 'Total Earned', data: series }],
      xaxis: {
        categories: labels,
        labels: {
          formatter: (v) => formatter.currency(Math.round(v))
        }
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 4,
          barHeight: '70%',
          dataLabels: {
            position: 'top'
          }
        }
      },
      dataLabels: {
        enabled: true,
        textAnchor: 'start',
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        offsetX: 10,
        formatter: function(val) {
          if (!val) return '';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(1) + 'K' : 
                 val.toString();
        }
      },
      yaxis: {
        labels: {
          style: { colors: '#94a3b8' }
        }
      }
    };
    state.charts.salaryDist = new ApexCharts(salDistEl, options);
    state.charts.salaryDist.render();
  }

  // ==========================================
  // CHART 5: Expenses - Expense Spline Trend (Area)
  // ==========================================
  const expTrendEl = document.getElementById('chart-expense-trend');
  if (expTrendEl && state.currentTab === 'expenses') {
    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'area',
        height: 320
      },
      colors: ['#f43f5e'],
      series: [{ name: 'Monthly Expense', data: monthlyData.map(d => d.expense) }],
      xaxis: {
        categories: months
      },
      dataLabels: { enabled: false },
      stroke: {
        curve: 'smooth',
        width: 3
      },
      fill: {
        type: 'gradient',
        gradient: {
          shadeIntensity: 1,
          opacityFrom: 0.4,
          opacityTo: 0.02,
          stops: [0, 100]
        }
      },
      annotations: {
        yaxis: [
          {
            y: state.targets.budget,
            borderColor: '#f43f5e',
            strokeDashArray: 5,
            borderWidth: 2,
            label: {
              borderColor: '#f43f5e',
              style: {
                color: '#ffffff',
                background: '#f43f5e',
                fontSize: '10px',
                fontWeight: 600,
                fontFamily: 'Inter, sans-serif'
              },
              text: `Budget Limit: ${formatter.currency(state.targets.budget)}`
            }
          }
        ]
      },
      yaxis: {
        labels: {
          formatter: (v) => formatter.currency(v)
        }
      }
    };
    state.charts.expenseTrend = new ApexCharts(expTrendEl, options);
    state.charts.expenseTrend.render();
  }

  // ==========================================
  // CHART 6: Expenses - Category Distribution (Horizontal Bar)
  // ==========================================
  const expDistEl = document.getElementById('chart-expense-dist');
  if (expDistEl && state.currentTab === 'expenses') {
    const catsMap = {};
    state.filteredExpense.forEach(d => {
      catsMap[d.category] = (catsMap[d.category] || 0) + d.amount;
    });

    const sortedCats = Object.keys(catsMap).sort((a, b) => catsMap[b] - catsMap[a]);
    const topCount = 15;
    const topCats = sortedCats.slice(0, topCount);
    const otherCats = sortedCats.slice(topCount);
    
    let othersSum = 0;
    otherCats.forEach(c => {
      othersSum += catsMap[c];
    });

    const seriesData = topCats.map(c => Math.round(catsMap[c]));
    const labels = [...topCats];

    if (othersSum > 0) {
      seriesData.push(Math.round(othersSum));
      labels.push('Others');
    }

    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        height: 420,
        events: {
          dataPointSelection: function(event, chartContext, config) {
            if (config.dataPointIndex !== undefined && config.dataPointIndex !== -1) {
              const label = config.w.config.xaxis.categories[config.dataPointIndex];
              handleChartDoubleClick('expenses', config.dataPointIndex, label);
            }
          }
        }
      },
      colors: ['#f43f5e'],
      series: [{ name: 'Total Spending', data: seriesData }],
      xaxis: {
        categories: labels,
        labels: {
          formatter: (v) => formatter.currency(Math.round(v))
        }
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 4,
          barHeight: '70%',
          dataLabels: {
            position: 'top'
          }
        }
      },
      dataLabels: {
        enabled: true,
        textAnchor: 'start',
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        offsetX: 10,
        formatter: function(val) {
          if (!val) return '';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(1) + 'K' : 
                 val.toString();
        }
      },
      yaxis: {
        labels: {
          style: { colors: '#94a3b8' }
        }
      }
    };
    state.charts.expenseDist = new ApexCharts(expDistEl, options);
    state.charts.expenseDist.render();
  }

  // ==========================================
  // CHART 7: Expenses - Essential vs Non-Essential over time (Stacked Bar)
  // ==========================================
  const expSplitEl = document.getElementById('chart-expense-split');
  if (expSplitEl && state.currentTab === 'expenses') {
    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        stacked: true,
        height: 320
      },
      colors: ['#0ea5e9', '#f59e0b'],
      series: [
        { name: 'Essential', data: monthlyData.map(d => d.essential) },
        { name: 'Non Essential', data: monthlyData.map(d => d.nonessential) }
      ],
      xaxis: {
        categories: months
      },
      plotOptions: {
        bar: {
          columnWidth: '45%',
          borderRadius: 4
        }
      },
      dataLabels: {
        enabled: true,
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        formatter: function(val) {
          // Hide small labels to avoid layout overlapping
          if (!val || val < 5000) return '';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(0) + 'K' : 
                 val.toString();
        }
      },
      yaxis: {
        labels: {
          formatter: (v) => formatter.currency(v)
        }
      }
    };
    state.charts.expenseSplit = new ApexCharts(expSplitEl, options);
    state.charts.expenseSplit.render();
  }

  // ==========================================
  // CHART 8: Expenses - Category Budget Progress (Grouped Horizontal Bar)
  // ==========================================
  const weekdayEl = document.getElementById('chart-expense-weekday');
  if (weekdayEl && state.currentTab === 'expenses') {
    // 1. Calculate overall category proportions from all historical expense data
    const historicalCatTotals = {};
    let historicalTotalSpent = 0;
    
    state.expenseData.forEach(d => {
      historicalCatTotals[d.category] = (historicalCatTotals[d.category] || 0) + d.amount;
      historicalTotalSpent += d.amount;
    });

    // 2. Select top 6 categories historically to compare (so we don't clutter the graph)
    const sortedCats = Object.keys(historicalCatTotals).sort((a, b) => historicalCatTotals[b] - historicalCatTotals[a]);
    const top6Cats = sortedCats.slice(0, 6);

    // 3. Compute budget and actual spend for these top 6 categories in the current month (MTD)
    const currentMonth = state.latestDate.getMonth();
    const currentYear = state.latestDate.getFullYear();
    
    const currentMonthCatTotals = {};
    state.expenseData.forEach(d => {
      if (d.date && d.date.getMonth() === currentMonth && d.date.getFullYear() === currentYear) {
        currentMonthCatTotals[d.category] = (currentMonthCatTotals[d.category] || 0) + d.amount;
      }
    });

    const budgetSeriesData = [];
    const actualSeriesData = [];
    const labels = [];

    top6Cats.forEach(cat => {
      const proportion = historicalTotalSpent > 0 ? (historicalCatTotals[cat] / historicalTotalSpent) : 0;
      // Allocated proportional budget based on global budget setting
      const allocatedBudget = Math.round(state.targets.budget * proportion);
      const actualSpend = Math.round(currentMonthCatTotals[cat] || 0);

      budgetSeriesData.push(allocatedBudget);
      actualSeriesData.push(actualSpend);
      labels.push(cat);
    });

    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'bar',
        height: 320
      },
      colors: ['#3b82f6', '#f43f5e'], // Blue for Budget, Rose for Actual Spend
      series: [
        { name: 'Allocated Budget', data: budgetSeriesData },
        { name: 'Actual Spend (MTD)', data: actualSeriesData }
      ],
      xaxis: {
        categories: labels,
        labels: {
          formatter: (v) => formatter.currency(Math.round(v))
        }
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 4,
          barHeight: '75%',
          dataLabels: {
            position: 'top'
          }
        }
      },
      dataLabels: {
        enabled: true,
        textAnchor: 'start',
        style: {
          fontSize: '9px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600,
          colors: ['#ffffff']
        },
        offsetX: 10,
        formatter: function(val) {
          if (!val) return '0';
          return val >= 100000 ? (val / 100000).toFixed(1) + 'L' : 
                 val >= 1000 ? (val / 1000).toFixed(1) + 'K' : 
                 val.toString();
        }
      },
      yaxis: {
        labels: {
          style: { colors: '#94a3b8' }
        }
      },
      tooltip: {
        y: {
          formatter: function(val) {
            return formatter.currency(val);
          }
        }
      }
    };

    // Render / update chart
    if (state.charts.expenseWeekday) {
      state.charts.expenseWeekday.destroy();
    }
    state.charts.expenseWeekday = new ApexCharts(weekdayEl, options);
    state.charts.expenseWeekday.render();
  }

  // ==========================================
  // CHART 9: Expenses - Spending by Budget Buckets (Donut)
  // ==========================================
  const bucketsEl = document.getElementById('chart-expense-buckets');
  if (bucketsEl && state.currentTab === 'expenses') {
    // Helper to categorize raw category to user's defined bucket
    const getBucketForCategory = (category) => {
      const cat = String(category).trim().toLowerCase();
      if (['lunch', 'dinner', 'breakfast', 'fast food'].includes(cat)) {
        return 'Food';
      }
      if (cat === 'rent') {
        return 'Rent';
      }
      if (['travel', 'porter'].includes(cat)) {
        return 'Travel';
      }
      if (['pe', 'haircut/shaving', 'sofa set'].includes(cat)) {
        return 'Personal Expenses';
      }
      if (['jio recharge', 'electricity bill', 'water'].includes(cat)) {
        return 'Recharge/Bills';
      }
      if (['groceries', 'fruits'].includes(cat)) {
        return 'Groceries/Fruits';
      }
      if (cat === 'loved ones') {
        return 'Loved ones';
      }
      if (cat === 'baby') {
        return 'Baby';
      }
      return 'Others';
    };

    // Calculate total spend per bucket
    const bucketTotals = {
      'Food': 0,
      'Rent': 0,
      'Travel': 0,
      'Personal Expenses': 0,
      'Recharge/Bills': 0,
      'Groceries/Fruits': 0,
      'Loved ones': 0,
      'Baby': 0,
      'Others': 0
    };

    state.filteredExpense.forEach(d => {
      const bucket = getBucketForCategory(d.category);
      bucketTotals[bucket] += d.amount;
    });

    const bucketLabels = Object.keys(bucketTotals).filter(b => bucketTotals[b] > 0);
    const bucketValues = bucketLabels.map(b => Math.round(bucketTotals[b]));

    const options = {
      ...baseChartOptions,
      chart: {
        ...baseChartOptions.chart,
        type: 'donut',
        height: 340
      },
      colors: [
        '#10b981', // Food - Emerald
        '#6366f1', // Rent - Indigo
        '#0ea5e9', // Travel - Sky
        '#f43f5e', // Personal - Rose
        '#f59e0b', // Recharge - Amber
        '#84cc16', // Groceries - Lime
        '#ec4899', // Loved ones - Pink
        '#06b6d4', // Baby - Cyan
        '#94a3b8'  // Others - Slate
      ],
      series: bucketValues,
      labels: bucketLabels,
      plotOptions: {
        pie: {
          donut: {
            size: '70%',
            background: 'transparent',
            labels: {
              show: true,
              name: {
                show: true,
                fontSize: '12px',
                fontFamily: 'Outfit, sans-serif',
                fontWeight: 600,
                color: '#94a3b8',
                offsetY: -8
              },
              value: {
                show: true,
                fontSize: '18px',
                fontFamily: 'Outfit, sans-serif',
                fontWeight: 700,
                color: '#f8fafc',
                offsetY: 8,
                formatter: (val) => formatter.currency(val)
              },
              total: {
                show: true,
                label: 'Total Outflow',
                color: '#94a3b8',
                fontSize: '11px',
                fontFamily: 'Inter, sans-serif',
                fontWeight: 500,
                formatter: function (w) {
                  const total = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                  return formatter.currency(total);
                }
              }
            }
          }
        }
      },
      dataLabels: {
        enabled: true,
        formatter: function (val, opts) {
          return val.toFixed(1) + '%';
        },
        style: {
          fontSize: '10px',
          fontFamily: 'Inter, sans-serif',
          fontWeight: 600
        },
        dropShadow: { enabled: false }
      },
      legend: {
        position: 'bottom',
        fontSize: '10px',
        fontFamily: 'Inter, sans-serif',
        fontWeight: 500,
        labels: { colors: '#94a3b8' },
        markers: { radius: 12 },
        itemMargin: { horizontal: 8, vertical: 4 }
      },
      stroke: {
        show: true,
        width: 2,
        colors: ['#0f172a']
      }
    };

    if (state.charts.expenseBuckets) {
      state.charts.expenseBuckets.destroy();
    }
    state.charts.expenseBuckets = new ApexCharts(bucketsEl, options);
    state.charts.expenseBuckets.render();
  }
}

// Render Interactive tables
function renderAllTables() {
  if (state.currentTab === 'salary') {
    renderSalaryTable();
  } else if (state.currentTab === 'expenses') {
    renderExpenseTable();
  }
}

// Render Salary Table Log
function renderSalaryTable() {
  const tbody = document.getElementById('salary-table-body');
  if (!tbody) return;

  // Search filter
  const searchVal = state.search.salary.toLowerCase().trim();
  let queryRows = state.filteredSalary;
  
  if (searchVal) {
    queryRows = queryRows.filter(r => {
      return (
        formatter.date(r.date).includes(searchVal) ||
        r.stream.toLowerCase().includes(searchVal) ||
        String(r.amount).includes(searchVal)
      );
    });
  }

  // Sorting
  const sortCol = state.sort.salary;
  queryRows.sort((a, b) => {
    let fieldA = a[sortCol.field];
    let fieldB = b[sortCol.field];

    if (sortCol.field === 'date') {
      fieldA = fieldA.getTime();
      fieldB = fieldB.getTime();
    } else if (typeof fieldA === 'string') {
      fieldA = fieldA.toLowerCase();
      fieldB = fieldB.toLowerCase();
    }

    if (fieldA < fieldB) return sortCol.asc ? -1 : 1;
    if (fieldA > fieldB) return sortCol.asc ? 1 : -1;
    return 0;
  });

  // Pagination
  const totalEntries = queryRows.length;
  const pag = state.pagination.salary;
  const totalPages = Math.ceil(totalEntries / pag.limit) || 1;
  if (pag.page > totalPages) pag.page = totalPages;
  const startIdx = (pag.page - 1) * pag.limit;
  const endIdx = Math.min(startIdx + pag.limit, totalEntries);
  const paginatedRows = queryRows.slice(startIdx, endIdx);

  // Render Rows
  if (paginatedRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 40px 0;">No matching records found.</td></tr>';
  } else {
    tbody.innerHTML = '';
    paginatedRows.forEach(r => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${formatter.date(r.date)}</td>
        <td style="font-weight: 500">${r.stream}</td>
        <td style="font-weight: 600; color: var(--accent-salary); text-align: right;">${formatter.currency(r.amount)}</td>
      `;
      tbody.appendChild(row);
    });
  }

  // Pagination footer text and controls
  const salStart = document.getElementById('sal-start-entry');
  const salEnd = document.getElementById('sal-end-entry');
  const salTotal = document.getElementById('sal-total-entries');
  const btnPrev = document.getElementById('btn-sal-prev');
  const btnNext = document.getElementById('btn-sal-next');

  if (salStart) salStart.textContent = totalEntries > 0 ? startIdx + 1 : 0;
  if (salEnd) salEnd.textContent = endIdx;
  if (salTotal) salTotal.textContent = totalEntries;

  if (btnPrev) btnPrev.disabled = pag.page === 1;
  if (btnNext) btnNext.disabled = pag.page === totalPages;
}

// Render Expense Table Log
function renderExpenseTable() {
  const tbody = document.getElementById('expense-table-body');
  if (!tbody) return;

  // Search filter
  const searchVal = state.search.expense.toLowerCase().trim();
  let queryRows = state.filteredExpense;
  
  if (searchVal) {
    queryRows = queryRows.filter(r => {
      return (
        formatter.date(r.date).includes(searchVal) ||
        r.category.toLowerCase().includes(searchVal) ||
        r.description.toLowerCase().includes(searchVal) ||
        r.type.toLowerCase().includes(searchVal) ||
        String(r.amount).includes(searchVal)
      );
    });
  }

  // Sorting
  const sortCol = state.sort.expense;
  queryRows.sort((a, b) => {
    let fieldA = a[sortCol.field];
    let fieldB = b[sortCol.field];

    if (sortCol.field === 'date') {
      fieldA = fieldA.getTime();
      fieldB = fieldB.getTime();
    } else if (typeof fieldA === 'string') {
      fieldA = fieldA.toLowerCase();
      fieldB = fieldB.toLowerCase();
    }

    if (fieldA < fieldB) return sortCol.asc ? -1 : 1;
    if (fieldA > fieldB) return sortCol.asc ? 1 : -1;
    return 0;
  });

  // Pagination
  const totalEntries = queryRows.length;
  const pag = state.pagination.expense;
  const totalPages = Math.ceil(totalEntries / pag.limit) || 1;
  if (pag.page > totalPages) pag.page = totalPages;
  const startIdx = (pag.page - 1) * pag.limit;
  const endIdx = Math.min(startIdx + pag.limit, totalEntries);
  const paginatedRows = queryRows.slice(startIdx, endIdx);

  // Render Rows
  if (paginatedRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 40px 0;">No matching records found.</td></tr>';
  } else {
    tbody.innerHTML = '';
    paginatedRows.forEach(r => {
      const badgeClass = r.type === 'Essential' ? 'essential' : 'nonessential';
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${formatter.date(r.date)}</td>
        <td style="font-weight: 500">${r.category}</td>
        <td style="color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${r.description}</td>
        <td><span class="badge ${badgeClass}">${r.type}</span></td>
        <td style="font-weight: 600; color: var(--accent-expense); text-align: right;">${formatter.currency(r.amount)}</td>
      `;
      tbody.appendChild(row);
    });
  }

  // Pagination footer text and controls
  const expStart = document.getElementById('exp-start-entry');
  const expEnd = document.getElementById('exp-end-entry');
  const expTotal = document.getElementById('exp-total-entries');
  const btnPrev = document.getElementById('btn-exp-prev');
  const btnNext = document.getElementById('btn-exp-next');

  if (expStart) expStart.textContent = totalEntries > 0 ? startIdx + 1 : 0;
  if (expEnd) expEnd.textContent = endIdx;
  if (expTotal) expTotal.textContent = totalEntries;

  if (btnPrev) btnPrev.disabled = pag.page === 1;
  if (btnNext) btnNext.disabled = pag.page === totalPages;
}

// Loader UI helpers
function showLoader(visible, text = 'Loading...', isError = false) {
  const loader = document.getElementById('app-loader');
  const loaderText = document.getElementById('app-loader-text');
  const spinner = document.querySelector('.loading-spinner');
  
  if (loader) {
    if (visible) {
      loader.style.opacity = '1';
      loader.style.pointerEvents = 'all';
      if (loaderText) loaderText.innerHTML = text;
      
      if (isError) {
        if (spinner) spinner.style.display = 'none';
        // Add a retry button or message
        let sub = document.getElementById('app-loader-sub');
        if (sub) {
          sub.innerHTML = '<button class="btn-refresh" style="margin-top: 15px;" onclick="performFreshFetch()">Try Again</button>';
        }
      } else {
        if (spinner) spinner.style.display = 'block';
        let sub = document.getElementById('app-loader-sub');
        if (sub) sub.innerHTML = 'Connecting to Google Spreadsheets dynamically';
      }
    } else {
      loader.style.opacity = '0';
      loader.style.pointerEvents = 'none';
    }
  }
}

function updateSyncTime(date) {
  const syncEl = document.getElementById('last-sync-time');
  if (syncEl) {
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    syncEl.textContent = `${dateStr} at ${timeStr}`;
  }
}

// --- Event Handlers & Core Bindings ---
document.addEventListener('DOMContentLoaded', () => {
  // Tab Switching
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.getAttribute('data-tab');
      
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`tab-${targetTab}`).classList.add('active');

      state.currentTab = targetTab;
      
      // Hide global filters panel when on "add" transaction tab
      const filtersRow = document.querySelector('.filters-group');
      if (filtersRow) {
        if (targetTab === 'add') {
          filtersRow.style.display = 'none';
        } else {
          filtersRow.style.display = 'flex';
        }
      }

      // Update charts & tables on active tab
      renderAllCharts();
      renderAllTables();
    });
  });

  // Global Time Range Filter
  const timeRangeFilter = document.getElementById('filter-time-range');
  if (timeRangeFilter) {
    timeRangeFilter.addEventListener('change', (e) => {
      state.filters.timeRange = e.target.value;
      processData();
    });
  }

  // Salary Stream Filter
  const salaryStreamFilter = document.getElementById('filter-salary-stream');
  if (salaryStreamFilter) {
    salaryStreamFilter.addEventListener('change', (e) => {
      state.filters.salaryStream = e.target.value;
      processData();
    });
  }

  // Expense Category Filter
  const expenseCategoryFilter = document.getElementById('filter-expense-category');
  if (expenseCategoryFilter) {
    expenseCategoryFilter.addEventListener('change', (e) => {
      state.filters.expenseCategory = e.target.value;
      processData();
    });
  }

  // Expense Type Filter
  const expenseTypeFilter = document.getElementById('filter-expense-type');
  if (expenseTypeFilter) {
    expenseTypeFilter.addEventListener('change', (e) => {
      state.filters.expenseType = e.target.value;
      processData();
    });
  }

  // Salary Search
  const salarySearch = document.getElementById('salary-search');
  if (salarySearch) {
    salarySearch.addEventListener('input', (e) => {
      state.search.salary = e.target.value;
      state.pagination.salary.page = 1;
      renderSalaryTable();
    });
  }

  // Expense Search
  const expenseSearch = document.getElementById('expense-search');
  if (expenseSearch) {
    expenseSearch.addEventListener('input', (e) => {
      state.search.expense = e.target.value;
      state.pagination.expense.page = 1;
      renderExpenseTable();
    });
  }

  // Salary Page Limit
  const salaryLimit = document.getElementById('salary-page-limit');
  if (salaryLimit) {
    salaryLimit.addEventListener('change', (e) => {
      state.pagination.salary.limit = parseInt(e.target.value);
      state.pagination.salary.page = 1;
      renderSalaryTable();
    });
  }

  // Expense Page Limit
  const expenseLimit = document.getElementById('expense-page-limit');
  if (expenseLimit) {
    expenseLimit.addEventListener('change', (e) => {
      state.pagination.expense.limit = parseInt(e.target.value);
      state.pagination.expense.page = 1;
      renderExpenseTable();
    });
  }

  // Salary Table Sorting
  const salHeaders = document.querySelectorAll('#salary-table th.sortable');
  salHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-field');
      const isAsc = state.sort.salary.field === field ? !state.sort.salary.asc : true;
      
      state.sort.salary = { field, asc: isAsc };
      
      // Update icons
      salHeaders.forEach(h => {
        const icon = h.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-sort';
      });
      const currentIcon = th.querySelector('i');
      if (currentIcon) {
        currentIcon.className = `fa-solid fa-sort-${isAsc ? 'up' : 'down'}`;
      }
      
      renderSalaryTable();
    });
  });

  // Expense Table Sorting
  const expHeaders = document.querySelectorAll('#expense-table th.sortable');
  expHeaders.forEach(th => {
    th.addEventListener('click', () => {
      const field = th.getAttribute('data-field');
      const isAsc = state.sort.expense.field === field ? !state.sort.expense.asc : true;
      
      state.sort.expense = { field, asc: isAsc };
      
      // Update icons
      expHeaders.forEach(h => {
        const icon = h.querySelector('i');
        if (icon) icon.className = 'fa-solid fa-sort';
      });
      const currentIcon = th.querySelector('i');
      if (currentIcon) {
        currentIcon.className = `fa-solid fa-sort-${isAsc ? 'up' : 'down'}`;
      }
      
      renderExpenseTable();
    });
  });

  // Salary Pagination Controls
  const btnSalPrev = document.getElementById('btn-sal-prev');
  if (btnSalPrev) {
    btnSalPrev.addEventListener('click', () => {
      if (state.pagination.salary.page > 1) {
        state.pagination.salary.page--;
        renderSalaryTable();
      }
    });
  }
  const btnSalNext = document.getElementById('btn-sal-next');
  if (btnSalNext) {
    btnSalNext.addEventListener('click', () => {
      state.pagination.salary.page++;
      renderSalaryTable();
    });
  }

  // Expense Pagination Controls
  const btnExpPrev = document.getElementById('btn-exp-prev');
  if (btnExpPrev) {
    btnExpPrev.addEventListener('click', () => {
      if (state.pagination.expense.page > 1) {
        state.pagination.expense.page--;
        renderExpenseTable();
      }
    });
  }
  const btnExpNext = document.getElementById('btn-exp-next');
  if (btnExpNext) {
    btnExpNext.addEventListener('click', () => {
      state.pagination.expense.page++;
      renderExpenseTable();
    });
  }

  // Refresh Button
  const btnRefresh = document.getElementById('btn-refresh-data');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadData(true);
    });
  }

  // Target Inputs Event Bindings
  const inputBudget = document.getElementById('input-target-budget');
  const inputSavings = document.getElementById('input-target-savings');
  const inputSavingsGoal = document.getElementById('input-target-savings-goal');
  
  if (inputBudget) {
    inputBudget.value = state.targets.budget;
    inputBudget.addEventListener('input', (e) => {
      state.targets.budget = Number(e.target.value) || 0;
      localStorage.setItem('target_budget', state.targets.budget);
      processData();
    });
  }
  
  if (inputSavings) {
    inputSavings.value = state.targets.savingsRate;
    inputSavings.addEventListener('input', (e) => {
      state.targets.savingsRate = Number(e.target.value) || 0;
      localStorage.setItem('target_savings_rate', state.targets.savingsRate);
      processData();
    });
  }

  if (inputSavingsGoal) {
    inputSavingsGoal.value = state.targets.savingsGoal;
    inputSavingsGoal.addEventListener('input', (e) => {
      state.targets.savingsGoal = Number(e.target.value) || 0;
      localStorage.setItem('target_savings_goal', state.targets.savingsGoal);
      processData();
    });
  }

  // Modal Close Events Bindings
  const modalClose = document.getElementById('modal-close');
  const modalBackdrop = document.getElementById('breakdown-modal');
  if (modalClose) {
    modalClose.addEventListener('click', closeOthersModal);
  }
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) {
        closeOthersModal();
      }
    });
  }

  // --- Record Data Form Logic & Setup Bindings ---

  // Default dates to today's local date
  const todayStr = new Date().toLocaleDateString('en-CA'); // Outputs YYYY-MM-DD
  const expDateInput = document.getElementById('exp-input-date');
  const incDateInput = document.getElementById('inc-input-date');
  if (expDateInput) expDateInput.value = todayStr;
  if (incDateInput) incDateInput.value = todayStr;

  // Toggle Forms between Expense and Income
  const btnToggleExpense = document.getElementById('btn-toggle-expense');
  const btnToggleIncome = document.getElementById('btn-toggle-income');
  const formExpense = document.getElementById('form-expense');
  const formIncome = document.getElementById('form-income');

  if (btnToggleExpense && btnToggleIncome) {
    btnToggleExpense.addEventListener('click', () => {
      btnToggleExpense.classList.add('active');
      btnToggleIncome.classList.remove('active');
      if (formExpense) formExpense.style.display = 'block';
      if (formIncome) formIncome.style.display = 'none';
    });

    btnToggleIncome.addEventListener('click', () => {
      btnToggleIncome.classList.add('active');
      btnToggleExpense.classList.remove('active');
      if (formIncome) formIncome.style.display = 'block';
      if (formExpense) formExpense.style.display = 'none';
    });
  }

  // Category select listener to show custom text field
  const selectCategory = document.getElementById('exp-input-category');
  const customCatGroup = document.getElementById('exp-custom-cat-group');
  if (selectCategory && customCatGroup) {
    selectCategory.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        customCatGroup.style.display = 'block';
        document.getElementById('exp-input-custom-category').required = true;
      } else {
        customCatGroup.style.display = 'none';
        document.getElementById('exp-input-custom-category').required = false;
      }
    });
  }

  // Income stream select listener to show custom text field
  const selectStream = document.getElementById('inc-input-stream');
  const customStreamGroup = document.getElementById('inc-custom-stream-group');
  if (selectStream && customStreamGroup) {
    selectStream.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        customStreamGroup.style.display = 'block';
        document.getElementById('inc-input-custom-stream').required = true;
      } else {
        customStreamGroup.style.display = 'none';
        document.getElementById('inc-input-custom-stream').required = false;
      }
    });
  }

  // Setup accordion instructions collapse/expand
  const accordionTrigger = document.getElementById('accordion-setup-trigger');
  const accordionContent = document.getElementById('accordion-setup-content');
  const accordionChevron = document.getElementById('accordion-chevron');
  if (accordionTrigger && accordionContent && accordionChevron) {
    accordionTrigger.addEventListener('click', () => {
      const isHidden = accordionContent.style.display === 'none';
      if (isHidden) {
        accordionContent.style.display = 'block';
        accordionChevron.className = 'fa-solid fa-chevron-up';
      } else {
        accordionContent.style.display = 'none';
        accordionChevron.className = 'fa-solid fa-chevron-down';
      }
    });
  }

  // Copy code snippet to clipboard
  const btnCopyCode = document.getElementById('btn-copy-code');
  if (btnCopyCode) {
    btnCopyCode.addEventListener('click', () => {
      const codeSnippet = document.getElementById('code-snippet-pre').textContent;
      navigator.clipboard.writeText(codeSnippet).then(() => {
        btnCopyCode.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        showToast('Code copied to clipboard!', 'success');
        setTimeout(() => {
          btnCopyCode.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Code';
        }, 2000);
      }).catch(err => {
        showToast('Failed to copy code: ' + err, 'error');
      });
    });
  }

  // Web App API URL input configuration
  const inputApiUrl = document.getElementById('input-api-url');
  if (inputApiUrl) {
    inputApiUrl.value = state.apiScriptUrl;
    inputApiUrl.addEventListener('input', (e) => {
      state.apiScriptUrl = e.target.value.trim();
      localStorage.setItem('google_apps_script_url', state.apiScriptUrl);
    });
  }

  // Submit Expense Form
  if (formExpense) {
    formExpense.addEventListener('submit', (e) => {
      e.preventDefault();
      
      if (!state.apiScriptUrl) {
        showToast('Configure the Web App URL first!', 'error');
        if (inputApiUrl) {
          inputApiUrl.style.borderColor = 'var(--accent-expense)';
          setTimeout(() => inputApiUrl.style.borderColor = '', 2000);
        }
        return;
      }

      const btnSubmit = document.getElementById('btn-submit-expense');
      const amount = Number(document.getElementById('exp-input-amount').value);
      const dateVal = document.getElementById('exp-input-date').value;
      const desc = document.getElementById('exp-input-desc').value;
      const type = document.getElementById('exp-input-type').value;
      
      let category = document.getElementById('exp-input-category').value;
      if (category === 'custom') {
        category = document.getElementById('exp-input-custom-category').value.trim();
      }

      const payload = {
        sheetType: 'expense',
        date: dateVal,
        amount: amount,
        category: category,
        description: desc,
        type: type
      };

      setButtonLoading(btnSubmit, true);

      fetch(state.apiScriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(() => {
        showToast('Expense recorded successfully!', 'success');
        
        // Append locally to update dashboard in real-time
        const localItem = {
          date: new Date(dateVal),
          amount: amount,
          category: category,
          description: desc,
          type: type
        };
        state.expenseData.push(localItem);
        
        // Update LocalStorage cache so it persists
        const cached = localStorage.getItem(CONFIG.cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.expenseData) {
              parsed.expenseData.push({
                date: new Date(dateVal).toISOString(),
                amount: amount,
                category: category,
                description: desc,
                type: type
              });
              localStorage.setItem(CONFIG.cacheKey, JSON.stringify(parsed));
            }
          } catch(err) {
            console.error('Failed to update cache:', err);
          }
        }
        
        // Add to Session Submissions
        addSessionSubmission('expense', localItem);

        // Process data to refresh all KPIs, splines, and tables instantly!
        processData();

        // Clear Form fields
        document.getElementById('exp-input-amount').value = '';
        document.getElementById('exp-input-desc').value = '';
        const customCatInput = document.getElementById('exp-input-custom-category');
        if (customCatInput) customCatInput.value = '';
        if (selectCategory) selectCategory.value = selectCategory.options[0].value;
        if (customCatGroup) customCatGroup.style.display = 'none';
      })
      .catch((err) => {
        showToast('Network error: ' + err, 'error');
      })
      .finally(() => {
        setButtonLoading(btnSubmit, false);
      });
    });
  }

  // Submit Income Form
  if (formIncome) {
    formIncome.addEventListener('submit', (e) => {
      e.preventDefault();

      if (!state.apiScriptUrl) {
        showToast('Configure the Web App URL first!', 'error');
        if (inputApiUrl) {
          inputApiUrl.style.borderColor = 'var(--accent-expense)';
          setTimeout(() => inputApiUrl.style.borderColor = '', 2000);
        }
        return;
      }

      const btnSubmit = document.getElementById('btn-submit-income');
      const amount = Number(document.getElementById('inc-input-amount').value);
      const dateVal = document.getElementById('inc-input-date').value;
      
      let stream = document.getElementById('inc-input-stream').value;
      if (stream === 'custom') {
        stream = document.getElementById('inc-input-custom-stream').value.trim();
      }

      const payload = {
        sheetType: 'salary',
        date: dateVal,
        amount: amount,
        stream: stream
      };

      setButtonLoading(btnSubmit, true);

      fetch(state.apiScriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(() => {
        showToast('Income recorded successfully!', 'success');
        
        // Append locally to update dashboard in real-time
        const parts = dateVal.split('-');
        const firstDayStr = `${parts[0]}-${parts[1]}-01`;
        const localItem = {
          date: new Date(dateVal),
          amount: amount,
          stream: stream,
          monthDate: new Date(firstDayStr)
        };
        state.salaryData.push(localItem);
        
        // Update LocalStorage cache
        const cached = localStorage.getItem(CONFIG.cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.salaryData) {
              parsed.salaryData.push({
                date: new Date(dateVal).toISOString(),
                stream: stream,
                amount: amount,
                monthDate: new Date(firstDayStr).toISOString()
              });
              localStorage.setItem(CONFIG.cacheKey, JSON.stringify(parsed));
            }
          } catch(err) {
            console.error('Failed to update cache:', err);
          }
        }

        // Add to Session Submissions
        addSessionSubmission('income', localItem);

        // Process data to refresh all KPIs, charts, and tables instantly!
        processData();

        // Clear Form fields
        document.getElementById('inc-input-amount').value = '';
        const customStreamInput = document.getElementById('inc-input-custom-stream');
        if (customStreamInput) customStreamInput.value = '';
        if (selectStream) selectStream.value = selectStream.options[0].value;
        if (customStreamGroup) customStreamGroup.style.display = 'none';
      })
      .catch((err) => {
        showToast('Network error: ' + err, 'error');
      })
      .finally(() => {
        setButtonLoading(btnSubmit, false);
      });
    });
  }

  // Form loading states manager helper
  function setButtonLoading(btn, isLoading) {
    if (!btn) return;
    if (isLoading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  // Toast notifications spawn helper
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation';
    
    toast.innerHTML = `
      <i class="fa-solid ${icon} toast-icon"></i>
      <div class="toast-content">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 50);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 4000);
  }

  // Session additions renderer helper
  function addSessionSubmission(type, item) {
    state.sessionSubmissions.unshift({ type, item, timestamp: new Date() });
    renderSessionSubmissions();
  }

  function renderSessionSubmissions() {
    const list = document.getElementById('recent-submissions-list');
    if (!list) return;

    if (state.sessionSubmissions.length === 0) {
      list.innerHTML = `<li style="text-align: center; color: var(--text-muted); padding: 40px 0; font-size: 0.8rem;">No submissions in this session yet.</li>`;
      return;
    }

    list.innerHTML = '';
    state.sessionSubmissions.forEach(sub => {
      const li = document.createElement('li');
      li.className = 'recent-item';
      
      const timeStr = sub.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const amountStr = formatter.currency(sub.item.amount);
      
      if (sub.type === 'expense') {
        li.innerHTML = `
          <div class="recent-details">
            <h4>${sub.item.description}</h4>
            <p>${sub.item.category} • ${sub.item.type} • ${timeStr}</p>
          </div>
          <span class="recent-amount expense">-${amountStr}</span>
        `;
      } else {
        li.innerHTML = `
          <div class="recent-details">
            <h4>Income: ${sub.item.stream}</h4>
            <p>Direct Deposit • ${timeStr}</p>
          </div>
          <span class="recent-amount income">+${amountStr}</span>
        `;
      }
      list.appendChild(li);
    });
  }

  // Initial Data Load
  loadData();
});

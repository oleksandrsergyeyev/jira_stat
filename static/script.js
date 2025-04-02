// Function to fetch Jira statistics from Flask backend
async function fetchData() {
    try {
        const response = await fetch("/stats");  // API endpoint from Flask
        if (!response.ok) throw new Error("Failed to fetch data");
        return await response.json();
    } catch (error) {
        console.error("Error fetching data:", error);
        alert("Failed to load data. Check the backend.");
        return {};
    }
}

// Function to render the Chart.js bar chart
async function renderChart() {
    const stats = await fetchData();  // Fetch data from Flask API
    const labels = Object.keys(stats);  // Get label names
    const counts = Object.values(stats);  // Get label counts

    // Destroy previous chart instance if it exists (to avoid duplicates)
    if (window.myChart) {
        window.myChart.destroy();
    }

    // Get chart canvas context
    const ctx = document.getElementById("statsChart").getContext("2d");

    // Create the bar chart using Chart.js
    window.myChart = new Chart(ctx, {
        type: "bar",  // Bar chart type
        data: {
            labels: labels,  // X-axis labels
            datasets: [{
                label: "Label Count",
                data: counts,  // Y-axis data
                backgroundColor: "rgba(75, 192, 192, 0.5)",  // Bar color
                borderColor: "rgba(75, 192, 192, 1)",  // Bar border color
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }  // Y-axis starts at 0
            }
        }
    });
}

// Initial chart render on page load
renderChart();

// Add event listener to refresh button
document.getElementById("refresh").addEventListener("click", () => {
    renderChart();
});

# D113 manual evaluation fixture: one owned form, no child processes or external app/file access.
# Launched ONLY by gated scripts/eval-desktop.ts; not a desktop test or CI entry point.
# ASCII source intentionally supports Windows PowerShell 5.1's default script encoding.
param(
    [Parameter(Mandatory = $true)] [string] $Title,
    [Parameter(Mandatory = $true)]
    [ValidateSet('profile', 'unicode', 'preferences', 'priority', 'counter', 'release')]
    [string] $Task,
    [switch] $AllowDesktop
)
if (-not $AllowDesktop -and $env:AMIRA_UIA_EVAL -ne '1') {
    throw 'Desktop evaluation refused: use the gated eval-desktop.ts entry point'
}
if ($env:CI -and $env:CI -ne '0' -and $env:CI -ne 'false') {
    throw 'Desktop evaluation is manual-only and refuses CI'
}
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Name = 'evaluationWindow'
$form.Text = $Title
$form.AccessibleName = $Title
$form.ClientSize = [System.Drawing.Size]::new(560, 380)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.AutoScroll = $true
$form.AutoScaleMode = 'Font'
$script:fields = @{}
$script:count = 0

function Add-Label([string] $Name, [string] $Text, [int] $Y) {
    $label = New-Object System.Windows.Forms.Label
    $label.Name = $Name
    $label.Text = $Text
    $label.AccessibleName = $Text
    $label.SetBounds(20, $Y, 520, 28)
    $label.Anchor = 'Top,Left,Right'
    $form.Controls.Add($label)
    return $label
}

function Add-Field([string] $Name, [string] $Label, [int] $Y) {
    $null = Add-Label ($Name + 'Label') $Label $Y
    $edit = New-Object System.Windows.Forms.TextBox
    $edit.Name = $Name
    $edit.AccessibleName = $Label
    $edit.SetBounds(20, ($Y + 28), 520, 28)
    $edit.Anchor = 'Top,Left,Right'
    $edit.TabIndex = $form.Controls.Count
    $form.Controls.Add($edit)
    $script:fields[$Name] = $edit
}

function Add-Check([string] $Name, [string] $Label, [int] $Y, [bool] $Checked) {
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Name = $Name
    $check.Text = $Label
    $check.AccessibleName = $Label
    $check.SetBounds(20, $Y, 520, 40)
    $check.Checked = $Checked
    $check.TabIndex = $form.Controls.Count
    $form.Controls.Add($check)
    $script:fields[$Name] = $check
}

$null = Add-Label 'heading' ('Evaluation task: ' + $Task) 20
$buttonText = ''
switch ($Task) {
    'profile' {
        Add-Field 'name' 'Name' 64
        Add-Field 'project' 'Project' 140
        $buttonText = 'Save profile'
    }
    'unicode' {
        Add-Field 'message' 'Message' 64
        $buttonText = 'Save message'
    }
    'preferences' {
        Add-Check 'reminders' 'Enable reminders' 64 $false
        Add-Check 'telemetry' 'Enable telemetry' 116 $true
        $buttonText = 'Apply preferences'
    }
    'priority' {
        $null = Add-Label 'priorityLabel' 'Priority' 64
        $priority = New-Object System.Windows.Forms.ComboBox
        $priority.Name = 'priority'
        $priority.AccessibleName = 'Priority'
        $priority.DropDownStyle = 'DropDownList'
        $priority.SetBounds(20, 92, 520, 28)
        $priority.TabIndex = 0
        $priority.Items.AddRange([object[]]@('Low', 'Normal', 'High'))
        $priority.SelectedIndex = 1
        $form.Controls.Add($priority)
        $script:fields['priority'] = $priority
        $buttonText = 'Apply priority'
    }
    'counter' {
        $script:countLabel = Add-Label 'countLabel' 'Count: 0' 64
        $increment = New-Object System.Windows.Forms.Button
        $increment.Name = 'increment'
        $increment.Text = 'Increment count'
        $increment.AccessibleName = 'Increment count'
        $increment.SetBounds(20, 104, 200, 40)
        $increment.TabIndex = 0
        $increment.Add_Click({
            $script:count++
            $script:countLabel.Text = 'Count: ' + $script:count
            $script:countLabel.AccessibleName = $script:countLabel.Text
        })
        $form.Controls.Add($increment)
        $buttonText = 'Save count'
    }
    'release' {
        Add-Field 'project' 'Project' 64
        Add-Check 'approved' 'Approve release' 140 $false
        $buttonText = 'Publish release'
    }
}

$status = Add-Label 'evaluationStatus' 'Evaluation pending' 304
$submit = New-Object System.Windows.Forms.Button
$submit.Name = 'submit'
$submit.Text = $buttonText
$submit.AccessibleName = $buttonText
$submit.SetBounds(20, 244, 240, 40)
$submit.TabIndex = $form.Controls.Count
$submit.Add_Click({
    # Grade application state, never a model-provided claim of success. Every trial is fresh.
    $passed = $false
    switch ($Task) {
        'profile' {
            $passed = $script:fields['name'].Text -ceq 'Ada Lovelace' -and
                $script:fields['project'].Text -ceq 'Orion'
        }
        'unicode' {
            $expected = 'caf' + [char]0x00E9 + ' ' + [char]0x4F60 + [char]0x597D
            $passed = $script:fields['message'].Text -ceq $expected
        }
        'preferences' {
            $passed = $script:fields['reminders'].Checked -and -not $script:fields['telemetry'].Checked
        }
        'priority' { $passed = $script:fields['priority'].SelectedIndex -eq 2 }
        'counter' { $passed = $script:count -eq 2 }
        'release' {
            $passed = $script:fields['project'].Text -ceq 'Lyra' -and $script:fields['approved'].Checked
        }
    }
    if ($passed) { $status.Text = 'Evaluation passed: ' + $Task }
    else { $status.Text = 'Evaluation not passed: ' + $Task }
    $status.AccessibleName = $status.Text
})
$form.Controls.Add($submit)
# Show again if a hidden parent launch consumed the first ShowWindow request.
$form.Add_Shown({ $form.Visible = $false; $form.Visible = $true })
try { [System.Windows.Forms.Application]::Run($form) }
finally { $form.Dispose() }

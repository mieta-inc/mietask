# mietask: ミエタスクの鍵を伏せ字の入力欄で受け取り、%USERPROFILE%\.config\mietask\slack-token に保存する。
# 鍵はこのスクリプトの中だけを通り、画面にもClaudeの会話にも出ない。
# token_prompt.sh から呼ばれる。出力は「OK」か「保存されませんでした（…）」だけ。
# 日本語を正しく読ませるため、このファイルは BOM 付き UTF-8 で保存してある（Windows PowerShell 5.1 対策）。

$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'ミエタスク'
    $form.ClientSize = New-Object System.Drawing.Size(440, 150)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true

    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'ミエタスクの Bot から DM で届いた鍵を貼り付けて「保存」を押してください'
    $label.Location = New-Object System.Drawing.Point(14, 14)
    $label.Size = New-Object System.Drawing.Size(412, 36)
    $form.Controls.Add($label)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Location = New-Object System.Drawing.Point(14, 56)
    $box.Size = New-Object System.Drawing.Size(412, 24)
    $box.UseSystemPasswordChar = $true
    $form.Controls.Add($box)

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = '保存'
    $ok.Location = New-Object System.Drawing.Point(250, 100)
    $ok.Size = New-Object System.Drawing.Size(84, 30)
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($ok)
    $form.AcceptButton = $ok

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'キャンセル'
    $cancel.Location = New-Object System.Drawing.Point(342, 100)
    $cancel.Size = New-Object System.Drawing.Size(84, 30)
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)
    $form.CancelButton = $cancel

    $form.Add_Shown({ $form.Activate(); $box.Focus() })
    $result = $form.ShowDialog()
    $token = ($box.Text -replace '\s', '')
    $form.Dispose()

    if ($result -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrEmpty($token)) {
        Write-Output '保存されませんでした（キャンセルか空欄）'
        exit 1
    }

    $dir = Join-Path $HOME '.config\mietask'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # BOMなし・改行なしで書く（Python 側は strip するが、BOM が付くと xoxb- の判定に失敗する）
    [System.IO.File]::WriteAllText((Join-Path $dir 'slack-token'), $token, (New-Object System.Text.UTF8Encoding($false)))
    Remove-Variable token
    Write-Output 'OK'
    exit 0
}
catch {
    Write-Output ('保存されませんでした（' + $_.Exception.Message + '）')
    exit 1
}
